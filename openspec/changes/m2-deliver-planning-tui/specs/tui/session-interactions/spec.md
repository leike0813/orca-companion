## Purpose

定义多 Coordinator Session 的选择与焦点约束、Pending Interaction 回答绑定，以及会话维护、模型配置切换与 Route Planning Handoff 在既有 TUI 中的入口与降级状态。

## ADDED Requirements

### Requirement: Session Picker、焦点约束与 Pending Interaction 回答绑定

系统 SHALL 通过 Session Picker 在多个 Coordinator Session 之间切换，并 SHALL 在启动时恢复上次选择；无历史选择时 SHALL 优先选择存在 Pending Interaction 的 Session，否则选择最近活动的 Session。新事件 SHALL 只增加未读或待处理标记，MUST NOT 自动切换 transcript、抢占 composer 或改变 Scope 级 Execution Graph。每个 Session 的 composer 草稿与滚动位置 SHALL 在进程内独立保存。Pending Interaction SHALL 以绑定 interaction ID 与 expected revision 的内联卡片呈现；用户进入回答模式后 composer SHALL 绑定该 interaction ID 与 expected revision，普通聊天消息 MUST NOT 满足待答问题，expected revision 过期时系统 SHALL 拒绝提交并提示重新读取。

#### Scenario: 启动时优先待答 Session
- **WHEN** 用户在无历史选择记录的情况下启动 TUI，且存在一个带 Pending Interaction 的 Session
- **THEN** Session Picker 默认选中该 Session

#### Scenario: 新事件不抢占焦点
- **WHEN** 用户正在向当前 Session 输入消息时另一 Session 收到新事件
- **THEN** 当前 transcript 与 composer 焦点不变，另一 Session 只增加未读标记

#### Scenario: 切换后保留草稿
- **WHEN** 用户在 Session A 输入未提交草稿后切换到 Session B 再切回 A
- **THEN** Session A 的 composer 草稿与滚动位置保持不变

#### Scenario: 普通消息不满足待答问题
- **WHEN** 用户以普通消息模式向含 Pending Interaction 的 Session 发送文本
- **THEN** 该消息不解析为回答，Pending Interaction 保持待答

#### Scenario: 过期 revision 的回答被拒绝
- **WHEN** 用户提交回答时该 Pending Interaction 的 expected revision 已过期
- **THEN** 系统拒绝提交并提示当前 revision 已变化

#### Scenario: 有效回答完成交互
- **WHEN** 用户以绑定 interaction ID 与当前 expected revision 的模式提交回答
- **THEN** 系统接受该回答并记录对应 Pending Interaction 已解决

### Requirement: 会话维护、模型配置与 Route Planning Handoff

系统 SHALL 在既有主视图与 Command Palette 提供 `/compact` 与 Model Picker，并 SHALL 支持 Route Planning Handoff 的 prepare、review 与 cutover；MUST NOT 为此新增应用页面。`compaction_degraded`、`context_exhausted`、handoff review 与 `awaiting_user_prompt` SHALL 在既有界面中可见。模型选择 SHALL 仅在 Coordinator Session 已 suspended 且无模型相关操作在途时可提交，系统 MUST NOT 自动 fallback。`compaction_degraded` 可以建议 handoff，但 MUST NOT 自动创建或切换 Session。Source checkpoint 不可恢复或无法生成可移植 Coordinator Context Capsule 时，Handoff SHALL fail closed 并保持 Scope blocked。

#### Scenario: 手动 compact 与降级状态可见
- **WHEN** 用户在 Command Palette 触发 `/compact`，或自动阈值 compact 失败后进入降级
- **THEN** 界面显示 compact 结果，并在降级时持续显示 `compaction_degraded` 的非阻塞告警

#### Scenario: 上下文耗尽停止新调用
- **WHEN** shake 后仍无法容纳当前输入与必要输出余量
- **THEN** 界面显示 `context_exhausted`，且不再发起新的模型调用

#### Scenario: 模型切换仅在挂起时提交
- **WHEN** Coordinator Session 正在运行模型或 compact，用户通过 Model Picker 选择新的 Coordinator Model Configuration
- **THEN** 系统拒绝或排队该选择，不中断进行中的模型或 tool step，也不自动 fallback

#### Scenario: Handoff 审阅与激活门
- **WHEN** 用户发起 Route Planning Handoff 并在 Review 界面确认
- **THEN** 界面展示 Capsule 摘要、Target 与待转移责任；cutover 后自动选中 Target，composer 指向 Target，且 Target 处于 `awaiting_user_prompt` 直到用户发送下一条普通 Prompt

#### Scenario: Handoff 灾难路径 fail closed
- **WHEN** Source checkpoint 不可恢复或必要 Coordinator Context Capsule 无法生成
- **THEN** 系统不创建替代 Coordinator Session、不转移 Ticket Claim，Scope 保持 blocked 并显示该 blocker
