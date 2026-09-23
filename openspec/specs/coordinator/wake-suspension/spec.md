# coordinator/wake-suspension Specification

## Purpose
定义 Coordinator Session 的可恢复挂起、best-effort 维护 lane、Actionable Work 投影与 Wake Batch 恢复准入，使模型只在确有需要其判断的工作出现时被唤醒。

## Requirements

### Requirement: Suspension and best-effort maintenance lane

当 Coordinator 没有可执行工作时，Session SHALL 通过一次挂起结束模型循环，并 SHALL NOT 停止前台 Controller、确定性对账、事件落盘或已运行的 Worker；挂起期间 MAY 在 Runtime Lease 与 fencing generation 保护下执行 best-effort keepalive，维护 SHALL 受有限 maintenance cycle 约束，且 SHALL NOT 产生业务状态推进。

#### Scenario: 挂起后前台仍在工作
- **WHEN** 一个 Session 在无 Actionable Work 时挂起
- **THEN** Controller SHALL 继续消费 Delivery、执行确定性对账并响应查询，Session SHALL 保持可恢复，且 SHALL NOT 被记为完成或取消

#### Scenario: 挂起是可恢复条件而非进程终止
- **WHEN** Session 处于挂起状态且新的 Actionable Work 出现
- **THEN** 同一 Session SHALL 能被恢复，且 SHALL NOT 需要新的 Coordinator Session 身份

#### Scenario: keepalive 不推进业务状态
- **WHEN** 挂起期间执行一次 best-effort keepalive
- **THEN** 该动作 SHALL NOT 创建 Wake Batch、SHALL NOT 记为 Committed Model Step、SHALL NOT 写入用户可见 transcript，且 SHALL NOT 改变 Session 图位置

#### Scenario: 维护受有限 cycle 与 fencing 约束
- **WHEN** 维护需要继续执行
- **THEN** 它 SHALL 只在 Runtime Lease 与当前 fencing generation 有效时执行，并按有限的 maintenance cycle 上限停止，SHALL NOT 以无限心跳持续保活

#### Scenario: Actionable Work 抢占维护
- **WHEN** 维护进行中准入新的 Actionable Work
- **THEN** 维护 SHALL 让位，模型 SHALL 以该 Wake Batch 恢复，维护 SHALL NOT 消费或推迟该工作

#### Scenario: Pause 或 Cancel 停止维护
- **WHEN** Coordination Scope 进入 Pause 或 Cancel
- **THEN** 维护 SHALL 停止且不发起新的 keepalive，已进行中的维护 SHALL NOT 阻止暂停或取消生效

### Requirement: Resumption requires admitted Actionable Work

模型恢复 SHALL 只由 durable Actionable Work 触发，并 SHALL 在恢复前以稳定 batch 身份同步写入恰好一个 Wake Batch；已提交的 Wake Batch SHALL NOT 被重复注入模型历史。

#### Scenario: 无 Actionable Work 时不唤醒
- **WHEN** 仅发生普通进度、keepalive、长轮询超时或无变化对账
- **THEN** 模型 SHALL NOT 被恢复，Session SHALL 保持挂起

#### Scenario: Wake Batch 先落盘再恢复
- **WHEN** Controller 判定存在 Actionable Work 并准备恢复模型
- **THEN** 它 SHALL 先取得 Runtime Lease、收集有界 Actionable Work、以稳定 WakeBatchId 写入 checkpoint，再记录 source admission 并调用模型循环

#### Scenario: 重复恢复不重复注入
- **WHEN** 进程在写入 Wake Batch 之后、模型恢复之前中断并再次启动
- **THEN** 该 batch SHALL 按稳定 source revision 与 batch ID 补齐，已提交的 batch SHALL NOT 被再次注入模型历史

### Requirement: User message admission

用户提交的普通 Session 消息 SHALL 先以稳定提交身份写入目标 Session 的持久历史，再作为该 Session 的 Actionable Work 准入；它 SHALL NOT 被解释为 Pending Interaction 回答。暂停时消息 MAY 被保存，但模型 SHALL 等 Resume 对账后才处理。相同提交身份的重放 SHALL 只产生一条消息和一次模型恢复。

#### Scenario: 提交后崩溃

- **WHEN** 用户消息已落盘而模型尚未开始或未完成响应时进程中断
- **THEN** 同一 Session 恢复后 SHALL 处理该消息一次，并保留其原文与提交身份

#### Scenario: 普通消息不回答交互

- **WHEN** 存在未决 Pending Interaction，用户提交普通 Session 消息
- **THEN** interaction SHALL 保持未决；只有绑定 interaction ID 与 expected revision 的回答意图 MAY 满足它
