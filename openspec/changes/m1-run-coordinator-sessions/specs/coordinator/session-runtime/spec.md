## Purpose

定义 Coordinator Session 的模型 loop 宿主、会话状态归属与单写者运行时约束，使一个 Session 能在进程重启后以同一身份恢复，并拒绝第二个写者。

## ADDED Requirements

### Requirement: Coordinator Session checkpoint isolation

每个 Coordinator Session SHALL 在独立的 checkpoint 线程中持久化自身的已提交消息、tool step 与图位置，且 SHALL NOT 与其他 Coordinator Session 共享同一线程。

#### Scenario: 同一 Scope 内两个 Session 互不可见
- **WHEN** 同一 Coordination Scope 内存在两个 Coordinator Session 并各自推进模型循环
- **THEN** 重启后每个 Session SHALL 只读回自己的已提交消息与图位置，任一 Session 的写入 SHALL NOT 改变另一个 Session 的可读状态

#### Scenario: 会话状态不含凭据与业务权威
- **WHEN** 写入一次 Session checkpoint
- **THEN** 持久化的会话状态 SHALL 只包含可 JSON 序列化的对话与 loop 进度，且 SHALL NOT 包含 provider 凭据、Orca 运行事实或 Route Map 内容

### Requirement: Single live Coordinator Runtime Incarnation

一个 Coordinator Session SHALL 同时最多有一个存活的 Runtime Incarnation；当 Runtime Lease 由存活进程持有时，其他进程 SHALL 在写入 checkpoint 或执行任何副作用之前被拒绝。

#### Scenario: 并发进程启动同一 Session 被拒绝
- **WHEN** 第二个进程尝试以同一 Coordinator Session 身份启动，而 Runtime Lease 仍由存活 incarnation 持有
- **THEN** 第二个进程 SHALL 以显式拒绝结束，且 SHALL NOT 写入 checkpoint、消费 Delivery 或发起外部 mutation

#### Scenario: 被 fence 的迟到进程写入被拒绝
- **WHEN** 一个 fencing generation 低于当前代际的进程尝试提交 checkpoint 或 Operation Intent
- **THEN** 该写入 SHALL 被拒绝，当前 incarnation 的持久状态 SHALL 保持不变

### Requirement: Committed model step and durable resumption identity

模型循环 SHALL 只在一次 Coordinator Agent 响应及其 tool calls 被原子接受为 Committed Model Step 之后才继续下一步；恢复 SHALL 沿用原 Coordination Scope、Coordinator Session、Planning Cycle 与已消耗预算。

#### Scenario: 未完整提交的响应不进入历史
- **WHEN** 一次模型响应在中途中断
- **THEN** 该响应 SHALL NOT 成为已提交历史的一部分，重启后模型循环 SHALL 从最后一次 Committed Model Step 之后继续

#### Scenario: 恢复不创建新身份
- **WHEN** 同一 Coordination Scope 的 Session 在进程重启后恢复
- **THEN** SHALL 复用原 Coordinator Session 身份、Planning Cycle 与已消耗预算，且 SHALL NOT 隐式创建新的 Session、Planning Cycle 或运行身份

#### Scenario: checkpoint 不可恢复时 fail closed
- **WHEN** 现有 Session 的 checkpoint 损坏或无法读回，且没有其他方式恢复同一会话
- **THEN** Session SHALL 阻塞并报告原因，SHALL NOT 创建替代 Coordinator Session、SHALL NOT 以空历史继续、SHALL NOT 转移 Ticket Claim 或 Execution Coordination Lease
