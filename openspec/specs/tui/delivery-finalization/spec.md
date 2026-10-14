# tui/delivery-finalization Specification

## Purpose
定义 Finalizer 门禁与 Delivery Verdict 的终态投影：按原授权的权限模式呈现只读或获批修复的 Finalizer 结论，确保只有真实可交付的项目被呈现为 deliverable。

## Requirements

### Requirement: Finalizer 门禁与 Delivery Verdict 投影

项目面板的工作记录与依据详情 SHALL 明确 Finalizer 运行的工作区、基线与最终版本，并显示原授权的权限模式、修复与集成核验及项目级 Evidence；详情 SHALL 在固定框内有界浏览，关闭后恢复原工作区。获准修复引起的工作区变化不构成自动 blocker；只有原 policy 为只读而该能力无法证明，以及越界、复验、版本、预算或集成不可证明时，系统 SHALL 只呈现 blocker，MUST NOT 呈现 deliverable；风险 SHALL 在常驻风险/Sidebar blocker 摘要可发现。系统 SHALL 只在独立的最终结论被确定性 controller 接受后投影 deliverable，并 SHALL 区分 implement 完成、单包 validation 通过与项目可交付三种事实；被接受的 blocker 结论 SHALL 与 deliverable 呈现为不同终态。

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
