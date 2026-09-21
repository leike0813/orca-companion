# recovery/controller-reconciliation Specification

## Purpose

定义 Companion 在启动、崩溃恢复与外部响应丢失时对未决副作用的对账行为，使任何无法证明未生效的外部动作都不会被静默重试或当作未发生。

## Requirements

### Requirement: 启动对账必须以原 OperationId 得出三值结论

Runtime Incarnation 在恢复模型循环或发起新的外部 mutation 之前，SHALL 读取持久化的 Operation Intent 集合，并逐个以原 OperationId 与已记录 receipt 对账。每个 intent 的结论 SHALL 归为已接受、已拒绝或未决三值之一。只有能够证明未产生副作用时，系统 MAY 判定为已拒绝；系统 MUST NOT 依据缺失响应、缺失 receipt 或传输故障推断某动作未发生，也 MUST NOT 更换 OperationId 重试。

#### Scenario: 中断后重新启动且存在未决 intent

- **WHEN** Companion 以已持久化但尚未完成的 Operation Intent 启动
- **THEN** 系统先按原 OperationId 与 receipt 对账，再决定是完成 intent、转为已拒绝，还是保持未决

#### Scenario: 响应丢失但动作已落地

- **WHEN** 外部 mutation 已产生副作用，但 Companion 未收到响应
- **THEN** 对账以只读查询结果判定为已接受，并沿用同一 OperationId 完成该 intent

#### Scenario: intent 无法证明未产生副作用

- **WHEN** 某个未决 intent 对应的只读查询既不返回已接受结果也不返回可证明未发生的证据
- **THEN** 系统把该 intent 视为未决，并阻塞其对应 mutation lane

### Requirement: mutation lane 阻塞必须可观测且可解除

被阻塞的 mutation lane SHALL 作为持久化的阻塞原因呈现，而不是静默挂起；该阻塞 MUST NOT 阻止其他已确定 lane 的读写与只读查询。解除阻塞 SHALL 仅发生在对账给出确定结论、或用户显式提供使该 lane 可判定的新事实之后；解除后系统 SHALL 重新校验 scope、ownership、revision 与预算。

#### Scenario: lane 阻塞期间的其他工作

- **WHEN** 一个 mutation lane 因未决 intent 被阻塞
- **THEN** 该阻塞对用户与 Coordinator Agent 可观测，且其他已确定 lane 的读写与只读查询不受影响

#### Scenario: 阻塞解除

- **WHEN** 对账得到确定结论，或用户补充了使该 lane 可判定的事实
- **THEN** 系统解除该 lane 的阻塞，并在继续前重新校验 scope、ownership、revision 与预算

### Requirement: 启动重放必须复用既有 Delivery pipeline

启动与崩溃恢复期间，Companion SHALL 把所有未确认 Delivery 交给前驱定义的唯一 `processDelivery` pipeline，不得实现第二套读取、去重、Accepted Worker Result 记录或 ack 顺序。来自旧 consumer generation、旧 Attempt 或已冻结代际的 Delivery SHALL 仅用于补充历史与确认，MUST NOT 推进当前生命周期、重启模型、消耗共享预算或覆盖较新事实；pipeline 返回 unknown 时 SHALL 阻塞对应 mutation lane，并沿用原 OperationId 对账。

#### Scenario: 启动时重放有效 Delivery

- **WHEN** Companion 启动时读取到一个身份与代际版本均匹配且尚未确认的 Delivery
- **THEN** 系统调用既有 `processDelivery` 完成结算，不创建第二套结果记录或确认路径

#### Scenario: pipeline 返回 unknown

- **WHEN** 既有 pipeline 无法确定 Orca 结果、receipt 或本地引用是否落盘
- **THEN** 系统保持 Delivery 未确认，阻塞对应 mutation lane，并以原 OperationId 对账

#### Scenario: 迟到完成消息

- **WHEN** 已冻结代际的 Worker 在较新代际开始之后投递完成消息
- **THEN** 系统记录该消息为历史，且不改变当前 Work Package 生命周期状态