## MODIFIED Requirements

### Requirement: Recovery 与 Segment 可观察

项目面板的工作记录与依据详情 SHALL 展示 Worker Session Recovery 使用的新 Session Segment、剩余 Recovery 预算、Recovery Capsule 的 `complete` 或 `partial` coverage、已知缺口与被 superseded 的原 Segment；相关语义事件 SHALL 进入项目面板最近事件。Recovery 失败 SHALL 在常驻风险/Sidebar blocker 摘要及工作详情呈现。界面 SHALL 区分替代 Session Segment 与原 provider session，MUST NOT 把 Recovery 呈现为原会话的连续恢复。详情 SHALL 在固定框内有界浏览，关闭后恢复原工作区。

#### Scenario: partial coverage 与缺口可见
- **WHEN** 某次 Recovery 使用 `partial` Recovery Capsule 成功创建替代 Segment
- **THEN** 项目工作详情显示该 Capsule 的 coverage 为 `partial`、已知缺口边界与剩余 Recovery 预算

#### Scenario: 迟到结果只补历史
- **WHEN** 被 superseded 的原 Session 在替代 Dispatch 被接受后返回结果
- **THEN** 界面只把该结果作为审计历史展示，不改变当前 Work Package 生命周期

#### Scenario: Recovery 失败投影为 blocker
- **WHEN** 某次 Recovery 因 transcript 不可用或材料矛盾失败
- **THEN** 界面以明确 blocker 呈现，且不显示该 Work Package 已恢复
