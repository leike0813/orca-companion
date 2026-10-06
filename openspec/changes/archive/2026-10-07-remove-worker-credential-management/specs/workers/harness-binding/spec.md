## MODIFIED Requirements

### Requirement: Dispatch 与真实 harness session 精确绑定

Controller SHALL 为 Specification Planner、Implementation、Validator 与 Finalizer 的每个 Worker Dispatch 建立并核验 Session Binding，覆盖确切的角色、harness 身份、harness session 身份、可引用 transcript 来源、该次启动实际使用的非秘密 runtime roots 与观察时间；绑定 SHALL 由该角色 profile 所绑定 harness 的 adapter 签发。当无法证明该 session 身份、harness 身份、transcript 来源或 runtime roots 时，Controller SHALL 将该绑定判为不可用并阻塞该 Dispatch 的推进，而不得按工作目录、时间、最近一次输出或最近会话推断。

#### Scenario: 精确绑定成功

- **WHEN** Orca 报告某 Dispatch 的 harness session 身份与 transcript 来源
- **THEN** Controller 记录包含角色、harness、session 身份、transcript 引用与 runtime roots 的 Session Binding，并仅以该来源读取该 Dispatch 的输出

#### Scenario: 四个主要角色均要求精确绑定

- **WHEN** Controller 准备推进 Specification Planner、Implementation、Validator 或 Finalizer 的任一 Worker Dispatch
- **THEN** 该 Dispatch 必须先具有可核验的 Session Binding 与 transcript 引用

#### Scenario: 无法证明 session 身份时阻塞

- **WHEN** Dispatch 的 harness session 身份、transcript 来源或 runtime roots 无法被证明
- **THEN** Controller 把该绑定判为不可用，并在重新核验前不据其输出推进生命周期

#### Scenario: harness 身份不匹配时不绑定

- **WHEN** 报告的 session 事实来自与该 Dispatch 绑定 profile 不同的 harness
- **THEN** Controller 拒绝该绑定并阻塞该 Dispatch，不把另一 harness 的会话当作原 session

### Requirement: Worker harness launch resolves the approved model binding

每个已注册 Worker Harness（codex、claude、opencode、pi、omp）的普通 Worker、Finalizer、Recovery Utility 与能力探针 SHALL 使用同一份配置生成及各自的内部 launcher，解析该角色固定 profile 的 harness、model 与 effort；启动 SHALL 继承真实 launch 的 `process.env`，MUST NOT 注入或改写凭据、隔离 HOME/XDG 或原生 provider 配置。公开 Orca terminal command 与 CLI 参数 SHALL 只包含非秘密描述符，MUST NOT 出现凭据引用或 secret。认证 SHALL 由该 harness 自身在真实用户环境中提供；provider 不可用、harness 未注册或模型选择缺证据 SHALL 阻塞，不自动 fallback 到其它模型、认证或 harness。

#### Scenario: 实际进程配置一致

- **WHEN** 启动批准的角色或替代 Session
- **THEN** 子进程实际收到该 profile 固定的 harness、model 与 effort，终端命令与持久记录不含 secret、不含隔离环境覆盖，精确 Session transcript 可核验模型

#### Scenario: 只读探针与正式启动一致

- **WHEN** 核验 Finalizer/Utility 只读能力并正式启动
- **THEN** 两者使用相同 harness launcher 与 profile 设置，保持已有 read-only sandbox/control 合同
