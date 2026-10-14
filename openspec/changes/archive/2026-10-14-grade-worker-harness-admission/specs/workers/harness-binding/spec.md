## MODIFIED Requirements

### Requirement: Dispatch 与真实 harness session 精确绑定

Controller SHALL 为每个 Dispatch 建立 Worker Execution Binding。基础级 SHALL 固定真实 Orca Task/Dispatch、exact Worker terminal、角色、Attempt 与物化授权；增强和完整级 SHALL 另有精确原生 Session Binding。仅允许对应绑定支持的操作，不以 Orca terminal 身份冒充原生 Session。

#### Scenario: 精确绑定成功
- **WHEN** Orca 报告增强或完整级 Dispatch 的原生 session 身份与 transcript 来源
- **THEN** Controller 记录包含角色、harness、session 身份、transcript 引用与 runtime roots 的原生 Session Binding，并仅以该来源读取该 Dispatch 的输出

#### Scenario: 四个主要角色均要求精确绑定
- **WHEN** Controller 准备推进 Specification Planner、Implementation、Validator 或 Finalizer 的任一 Worker Dispatch
- **THEN** 该 Dispatch 必须先具有可核验的 Worker Execution Binding；增强和完整级另需精确原生 Session Binding

#### Scenario: 无法证明 session 身份时阻塞
- **WHEN** 增强或完整级 Dispatch 的原生 session 身份、transcript 来源或 runtime roots 无法被证明
- **THEN** Controller 把该原生绑定判为不可用，并在重新核验前不据其输出推进生命周期

#### Scenario: harness 身份不匹配时不绑定
- **WHEN** 报告的原生 session 事实来自与该 Dispatch 绑定 profile 不同的 harness
- **THEN** Controller 拒绝该原生绑定并阻塞该 Dispatch，不把另一 harness 的会话当作原 session

#### Scenario: 基础绑定重启
- **WHEN** 基础任务派发后 Companion 重启
- **THEN** 沿原 Orca 身份对账、核验结果，不等待原生报告、不重复派发

### Requirement: Worker 存活与终态必须可核验

Controller SHALL 保留 live/exited/unverifiable 三态，不完整信息不能证明退出。结果结算 SHALL 核验 Task/Dispatch/Attempt、角色、Worker Execution Binding 与结果收据；unknown 沿原 OperationId 对账。

#### Scenario: 信息不完整时判为 unverifiable
- **WHEN** 某 Worker 的终端信息缺失，或其执行主机未被列举
- **THEN** Controller 将其判定为 unverifiable，且不触发重新派发

#### Scenario: 明确退出后不重复派发
- **WHEN** Controller 能够证明 Worker 已退出，且其 Dispatch 已有终态收据
- **THEN** Controller 不为该 Dispatch 触发重复派发，而是进入结算路径

#### Scenario: 终态身份不匹配时不结算
- **WHEN** 某个终态收据无法匹配该 Worker 的 Task、Dispatch、Attempt、角色、Worker Execution Binding 或原生 Session Binding
- **THEN** Controller 不结算该 Worker Task，并把终态判定为不可核验

#### Scenario: 身份不一致
- **WHEN** Delivery 属于其他 Dispatch 或 Attempt
- **THEN** 阻塞结算，不按当前默认 profile 或最近任务猜归属
