## Purpose

定义 Worker Session Recovery、superseded 结果、partial coverage、Execution Handoff 与 unknown/unverifiable 状态在既有 TUI 中的可观察性。

## ADDED Requirements

### Requirement: Recovery 与 Segment 可观察

Sidebar 与 Event Drawer SHALL 展示 Worker Session Recovery 使用的新 Session Segment、剩余 Recovery 预算、Recovery Capsule 的 `complete` 或 `partial` coverage、被 superseded 的原 Segment 以及 Recovery 失败形成的 blocker。界面 SHALL 区分替代 Session Segment 与原 provider session，MUST NOT 把 Recovery 呈现为原会话的连续恢复。

#### Scenario: partial coverage 与缺口可见
- **WHEN** 某次 Recovery 使用 `partial` Recovery Capsule 成功创建替代 Segment
- **THEN** 界面显示该 Capsule 的 coverage 为 `partial`、已知缺口边界与剩余 Recovery 预算

#### Scenario: 迟到结果只补历史
- **WHEN** 被 superseded 的原 Session 在替代 Dispatch 被接受后返回结果
- **THEN** 界面只把该结果作为审计历史展示，不改变当前 Work Package 生命周期

#### Scenario: Recovery 失败投影为 blocker
- **WHEN** 某次 Recovery 因 transcript 不可用或材料矛盾失败
- **THEN** 界面以明确 blocker 呈现，且不显示该 Work Package 已恢复

### Requirement: Execution Handoff 复用既有交互

Execution Coordination Handoff SHALL 复用前驱已交付的 handoff 交互与 Command Palette 入口，并只投影 `ExecutionHandoffState`，MUST NOT 复用 `PlanningHandoffProposal` 或新增应用页面。系统 SHALL 在既有界面展示 Execution Handoff 的 review、Target Session 与待转移责任，并 SHALL 保持 Run、Task、Dispatch、Attempt、Worker、worktree、Execution Graph、Authorization 与预算身份不变。Cutover 后系统 SHALL 自动选中 Target，Source transcript 只读；Target SHALL 处于 `awaiting_user_prompt` 直到用户发送下一条普通 Prompt。Source checkpoint 不可恢复或无法生成可移植 Coordinator Context Capsule 时，Handoff SHALL fail closed，界面 SHALL 以 blocker 呈现。

#### Scenario: 执行责任交接不改变运行身份
- **WHEN** 用户在 Execution Coordination 中确认 Execution Handoff 的 cutover
- **THEN** 界面自动选中 Target，在途 Worker 与 Run、Task、Dispatch、Attempt、worktree、Authorization 身份保持不变

#### Scenario: 交接后等待用户 Prompt
- **WHEN** Cutover 完成且用户尚未向 Target 发送普通 Prompt
- **THEN** 界面显示 `awaiting_user_prompt`，Worker 事件只增量落盘而不唤醒 Target 模型

#### Scenario: 交接灾难路径 fail closed
- **WHEN** Source checkpoint 不可恢复或必要 Coordinator Context Capsule 无法生成
- **THEN** 界面保持 Source 为唯一 owner 并以明确 blocker 呈现，不激活 prepared Target

### Requirement: unknown 与 unverifiable 的如实呈现

系统 SHALL 把 mutation 的 unknown 结果与 Worker liveness 的 `unverifiable` 呈现为待对账或不可核验状态，MUST NOT 呈现为失败或已停止。重绘 SHALL 只反映已持久化的状态与语义事件，MUST NOT 因展示需要触发重试或对账写入。

#### Scenario: unknown 不呈现为失败
- **WHEN** 一次 Worker 停止请求返回 unknown 结果
- **THEN** 界面把该动作呈现为待对账，不呈现为停止失败或已停止

#### Scenario: 展示不触发重试
- **WHEN** 用户刷新或重绘包含 unknown 状态的视图
- **THEN** 不产生新的重试、对账写入或派发
