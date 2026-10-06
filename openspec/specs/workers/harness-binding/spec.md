## Purpose

定义 Specification Planner、Implementation、Validator 与 Finalizer 的 Dispatch 如何与真实 harness session 及可引用 transcript 精确绑定，并形成 liveness、可核验终态与中断 Session Segment 事实，供后续恢复 change 使用。

## Requirements

### Requirement: Dispatch 与真实 harness session 精确绑定

Controller SHALL 为 Specification Planner、Implementation、Validator 与 Finalizer 的每个 Worker Dispatch 建立并核验 Session Binding，覆盖确切的角色、harness 身份、harness session 身份与可引用 transcript 来源；绑定 SHALL 由该角色 profile 所绑定 harness 的 adapter 签发。当无法证明该 session 身份、harness 身份或 transcript 来源时，Controller SHALL 将该绑定判为不可用并阻塞该 Dispatch 的推进，而不得按工作目录、时间或最近一次输出推断 session。

#### Scenario: 精确绑定成功

- **WHEN** Orca 报告某 Dispatch 的 harness session 身份与 transcript 来源
- **THEN** Controller 记录包含角色、harness、session 身份与 transcript 引用的 Session Binding，并仅以该来源读取该 Dispatch 的输出

#### Scenario: 四个主要角色均要求精确绑定

- **WHEN** Controller 准备推进 Specification Planner、Implementation、Validator 或 Finalizer 的任一 Worker Dispatch
- **THEN** 该 Dispatch 必须先具有可核验的 Session Binding 与 transcript 引用

#### Scenario: 无法证明 session 身份时阻塞

- **WHEN** Dispatch 的 harness session 身份无法被证明
- **THEN** Controller 把该绑定判为不可用，并在重新核验前不据其输出推进生命周期

#### Scenario: harness 身份不匹配时不绑定

- **WHEN** 报告的 session 事实来自与该 Dispatch 绑定 profile 不同的 harness
- **THEN** Controller 拒绝该绑定并阻塞该 Dispatch，不把另一 harness 的会话当作原 session

### Requirement: Worker 存活与终态必须可核验

Controller SHALL 将 Worker 存活判定为 live、exited 或 unverifiable 三者之一。仅在能够证明进程存活或其所在执行主机已被列举且明确不含该终端时，Controller 才可判定为 live 或 exited；信息缺失或不完整时 SHALL 判定为 unverifiable，且不得据此推断退出或触发重复派发。Worker Task 只有在匹配的 Task、Dispatch、Attempt、角色、Session Binding 与终态收据均可核验时，才可进入结算。

#### Scenario: 信息不完整时判为 unverifiable

- **WHEN** 某 Worker 的终端信息缺失，或其执行主机未被列举
- **THEN** Controller 将其判定为 unverifiable，且不触发重新派发

#### Scenario: 明确退出后不重复派发

- **WHEN** Controller 能够证明 Worker 已退出，且其 Dispatch 已有终态收据
- **THEN** Controller 不为该 Dispatch 触发重复派发，而是进入结算路径

#### Scenario: 终态身份不匹配时不结算

- **WHEN** 某个终态收据无法匹配该 Worker 的 Task、Dispatch、Attempt、角色或 Session Binding
- **THEN** Controller 不结算该 Worker Task，并把终态判定为不可核验

### Requirement: 会话中断只形成 Session Segment 前置事实

当 Worker Harness 会话中断时，Controller SHALL 为该次作业显式记录一个 Session Segment，包含角色、Task、Dispatch、Attempt、Session Binding、最后可引用 transcript 位置与中断时可核验的终态。该事实 SHALL 只供后续判断与恢复 change 使用；本 change SHALL NOT 恢复 Worker Session、生成 Recovery Capsule、记录或消耗 Recovery Budget，也不得把替代 session 视为原 Session Segment 的继续。

#### Scenario: 中断时记录 Segment 边界

- **WHEN** 某 Worker 的 harness 会话中断
- **THEN** Controller 记录该 Session Segment 的身份、transcript 引用、中断边界与可核验终态，不触发任何恢复动作

#### Scenario: 中断后不伪装继续原 session

- **WHEN** 原 harness session 已丢失或 transcript 无法引用
- **THEN** Controller 将当前工作标记为 blocker，且不生成 Capsule、不创建替代 segment、不继续原 attempt；后继 change 可在其规格允许时按正常 Retry Attempt 重开

### Requirement: Worker harness launch resolves the approved model binding

每个已注册 Worker Harness（codex、claude、opencode、pi、omp）的普通 Worker、Finalizer、Recovery Utility 与能力探针 SHALL 使用同一份配置生成及各自的内部 launcher，解析该角色固定 profile 的 harness、provider/model/effort/options 与 credentialRef；秘密 SHALL 只进入子进程环境，公开 Orca terminal command 与 CLI 参数 SHALL 只包含非秘密描述符。managed key SHALL 不被既有 Harness auth 覆盖；Harness-login SHALL 沿原认证方式并使用隔离状态根。provider 不可用、harness 未注册或凭据缺失 SHALL 阻塞，不自动 fallback 到其它模型、认证或 harness。

#### Scenario: 实际进程配置一致

- **WHEN** 启动批准的角色或替代 Session
- **THEN** 子进程实际收到该 profile 固定的 harness、provider/model/effort 和认证，终端命令与持久记录不含 key，精确 Session transcript 可核验模型

#### Scenario: 只读探针与正式启动一致

- **WHEN** 核验 Finalizer/Utility 只读能力并正式启动
- **THEN** 两者使用相同 harness launcher 与 profile 设置，保持已有 read-only sandbox/control 合同
