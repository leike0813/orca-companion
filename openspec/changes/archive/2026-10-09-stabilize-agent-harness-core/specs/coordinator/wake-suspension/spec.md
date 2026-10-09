## ADDED Requirements

### Requirement: Halted turn overrides automatic wake
Session 的故障或未结束轮次 SHALL 优先于 Actionable Work 自动唤醒；轮询、用户消息受理、来源重复准入与维护 SHALL NOT 解除停止。用户明确恢复且历史、权限、租约和未知 mutation 经核验后才可继续。

#### Scenario: 故障期间继续输入
- **WHEN** 停止的 Session 受理新消息或收到已准入工作
- **THEN** 输入持久保留，但不触发模型；明确恢复后沿原来源处理

## MODIFIED Requirements

### Requirement: User message admission

用户提交的普通 Session 消息 SHALL 先以稳定提交身份写入目标 Session 的持久历史，再作为该 Session 的 Actionable Work 准入；它 SHALL NOT 被解释为 Pending Interaction 回答。暂停或轮次停止时消息 MAY 被保存，但模型 SHALL 等明确恢复对账后才处理。相同提交身份的重放 SHALL 只产生一条消息和一次模型恢复。

#### Scenario: 提交后崩溃
- **WHEN** 用户消息已落盘而模型尚未开始或未完成响应时进程中断
- **THEN** 同一 Session 保留原文与提交身份；未结束轮次经用户明确恢复后处理，不因重启自动重复请求

#### Scenario: 普通消息不回答交互
- **WHEN** 存在未决 Pending Interaction，用户提交普通 Session 消息
- **THEN** interaction SHALL 保持未决；只有绑定 interaction ID 与 expected revision 的回答意图 MAY 满足它
