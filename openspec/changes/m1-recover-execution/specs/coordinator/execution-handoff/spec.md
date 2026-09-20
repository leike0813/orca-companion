## Purpose

定义 Execution Coordination 中 Coordinator Session 责任如何经 prepare、review 与 CAS cutover 转移，并与普通 suspend/resume 明确分离。

## ADDED Requirements

### Requirement: Execution Handoff 以独立状态和 CAS 转移执行责任

Execution Handoff SHALL 由持久化的 `ExecutionHandoffState` 表达 prepare、review 与 cutover；它 MUST NOT 复用 `PlanningHandoffProposal` 或由普通 suspend/resume 隐式触发。prepare 与 review 期间 Source Session SHALL 保持唯一 owner。review SHALL 校验 Source checkpoint、可移植 Coordinator Context Capsule、Target Session、expected revision，以及待转移的 Execution Coordination Lease、相关 Pending Interaction 与当前 Graph Generation 后续 Worker 生命周期事件责任。只有 cutover SHALL 以单次 CAS 转移这些责任，并 SHALL 保持 Run、Task、Dispatch、Attempt、Worker、worktree、Execution Graph、Authorization 与预算身份不变。Cutover 后 Target SHALL 进入 `awaiting_user_prompt`；在用户发送下一条普通 Prompt 前，Worker 事件继续落盘和对账，但 MUST NOT 自动激活 Target 的模型循环。任一步失败 SHALL 保持 Source 为唯一 owner 并记录 blocker。

#### Scenario: prepare 与 review 不提前转移责任

- **WHEN** Execution Handoff 已 prepare 或 review，但尚未成功 cutover
- **THEN** Source Session 仍持有全部执行责任，Target 只能读取审阅信息

#### Scenario: cutover 原子转移责任但保持运行身份

- **WHEN** review 已通过且 expected revision 仍匹配，用户确认 cutover
- **THEN** 系统以一次 CAS 转移 Lease、相关 Pending Interaction 与后续 Worker 事件责任；运行身份、图、授权与预算身份不变，Target 进入 `awaiting_user_prompt`

#### Scenario: Capsule 或 CAS 失败时保持 Source owner

- **WHEN** Source checkpoint 不可恢复、Coordinator Context Capsule 不可移植，或 cutover CAS 失败
- **THEN** 系统不激活 Target，保持 Source 为唯一 owner，并把失败投影为 Scope blocker
