## RENAMED Requirements

- FROM: `### Requirement: Codex launch resolves the approved model binding`
- TO: `### Requirement: Worker harness launch resolves the approved model binding`

## MODIFIED Requirements

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

### Requirement: Worker harness launch resolves the approved model binding

每个已注册 Worker Harness（codex、claude、opencode、pi、omp）的普通 Worker、Finalizer、Recovery Utility 与能力探针 SHALL 使用同一份配置生成及各自的内部 launcher，解析该角色固定 profile 的 harness、provider/model/effort/options 与 credentialRef；秘密 SHALL 只进入子进程环境，公开 Orca terminal command 与 CLI 参数 SHALL 只包含非秘密描述符。managed key SHALL 不被既有 Harness auth 覆盖；Harness-login SHALL 沿原认证方式并使用隔离状态根。provider 不可用、harness 未注册或凭据缺失 SHALL 阻塞，不自动 fallback 到其它模型、认证或 harness。

#### Scenario: 实际进程配置一致

- **WHEN** 启动批准的角色或替代 Session
- **THEN** 子进程实际收到该 profile 固定的 harness、provider/model/effort 和认证，终端命令与持久记录不含 key，精确 Session transcript 可核验模型

#### Scenario: 只读探针与正式启动一致

- **WHEN** 核验 Finalizer/Utility 只读能力并正式启动
- **THEN** 两者使用相同 harness launcher 与 profile 设置，保持已有 read-only sandbox/control 合同
