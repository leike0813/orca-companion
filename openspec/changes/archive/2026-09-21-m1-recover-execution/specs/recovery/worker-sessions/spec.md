## Purpose

定义 Worker Session Recovery：Worker Harness session 中断后的统一恢复生命周期，覆盖 Specification Planner、Implementation、Validator 与 Finalizer，并约束替代 Session 的身份、预算与证据边界。

## ADDED Requirements

### Requirement: Worker Session Recovery 先尝试精确恢复且不得凭不完整信息推断退出

Worker Session Recovery SHALL 是 Worker Harness session 中断后的唯一恢复生命周期，适用于 Specification Planner、Implementation、Validator 与 Finalizer 四类角色；Coordinator Session 的恢复 MUST NOT 走该生命周期。系统 SHALL 先尝试按精确 Session Binding 恢复原会话；当存活或身份证据不充分时，系统 SHALL 判定为 unverifiable，并 MUST NOT 据此推断该会话已退出、已失败或需要重新派发。

#### Scenario: 可精确绑定的中断

- **WHEN** 中断的 Worker Harness session 能按精确 Session Binding 与记录的 Worker Attempt 对应
- **THEN** 系统先尝试精确恢复原会话，而不是直接创建替代 Session

#### Scenario: 存活不可判定

- **WHEN** 无法充分证明该 Worker Harness session 仍存活或已退出
- **THEN** 系统把其标记为 unverifiable，并保持未决，不推断退出也不触发重复派发

#### Scenario: Coordinator Session 中断

- **WHEN** Coordinator Session 本身中断
- **THEN** 系统按其自身 checkpoint 与启动对账处理，不创建 RecoveryId、Session Segment 或 Recovery Capsule

### Requirement: Recovery 必须以稳定 RecoveryId 与预写 Operation Intent 启动且按 Worker Attempt 计数

每次 Worker Session Recovery SHALL 使用稳定的 RecoveryId，并 SHALL 在执行替代 Session 等副作用之前预写 Operation Intent；替代 Session Segment 一经创建 SHALL 立即消耗该 Worker Attempt 的一次 Recovery Budget。Recovery Budget SHALL 按每个 Worker Attempt 独立计数，与其实现、验证、修复等业务预算分开；默认额度与上限 SHALL 来自 Execution Authorization Manifest，并且重启、恢复、Patch 或重规划 MUST NOT 重置已消耗额度。系统 SHALL 默认复用该角色原 Worker Profile，只有 Authorization 允许兼容替代时才 SHALL 切换 Profile；workspace 丢失或不可对账时 SHALL 失败。

#### Scenario: 重启续办同一 Recovery

- **WHEN** Companion 在一次未完成的 Recovery 上重启
- **THEN** 系统以同一 RecoveryId 与预写的 Operation Intent 续办该 Recovery，而不是新建 Recovery 或重复消耗额度

#### Scenario: 创建替代 Segment 即消耗额度

- **WHEN** 系统为某个 Worker Attempt 创建了一个替代 Session Segment
- **THEN** 该 Worker Attempt 的已消耗 Recovery Budget 立即加一，且后续重启沿用该计数

#### Scenario: 超出默认或上限

- **WHEN** 某 Worker Attempt 的 Recovery Budget 达到 Authorization Manifest 给定的上限
- **THEN** 系统阻塞该 Worker Attempt 的继续恢复，并将其呈现为需要用户或重规划处理的阻塞

#### Scenario: workspace 不可对账

- **WHEN** 原 Worker Attempt 的 workspace 已丢失或无法与其记录对账
- **THEN** Recovery 失败并阻塞，系统不新建 worktree 冒充原 Attempt

### Requirement: 替代 Session 保留业务身份但创建新 Dispatch 与 Segment

由 Worker Session Recovery 产生的替代 Session SHALL 保留原 Worker Task、Task Contract、revision 与业务 Attempt 身份，并 SHALL 创建新的 Dispatch、Session Binding 与 Session Segment；系统 MUST NOT 复用原 Dispatch 或原 Segment 的绑定。在替代 Dispatch 被接受之前，若原 Session 到达有效终态，系统 MAY 以该终态结束 Recovery；此后原 Segment SHALL 标记为 superseded，其迟到结果 MUST NOT 推进当前流程，只能作为历史保留。

#### Scenario: 替代 Session 完成

- **WHEN** Recovery 产生替代 Session
- **THEN** 系统保留原 Worker Task、contract、revision 与业务 Attempt，同时创建新的 Dispatch、Session Binding 与 Session Segment

#### Scenario: 替代派发前原会话结束

- **WHEN** 替代 Dispatch 尚未被接受，而原 Session 到达有效终态
- **THEN** 系统以该终态结束 Recovery，并把原 Segment 标记为 superseded

#### Scenario: superseded Segment 迟到结果

- **WHEN** 已标记 superseded 的原 Segment 之后返回结果
- **THEN** 系统只把它记录为历史，不改变当前 Worker Attempt 的状态

### Requirement: Recovery Capsule 必须由受限 Utility Worker 生成且按角色门判定

Recovery Capsule SHALL 由一个受限 Utility Worker 通过 Task Envelope 从精确 transcript 提取产生，其结论 SHALL 为 complete 或 partial。Worker Harness Adapter SHALL 提供与 Dispatch、Session Binding 绑定的可寻址 transcript 材料及读取覆盖证据；来源 MAY 是 Orca provider transcript，也 MAY 是 harness 自己证明的 transcript。`transcript_unavailable` SHALL 表示没有经证明的可寻址 transcript；partial SHALL 仅表示精确 transcript 中存在 Adapter 已定位并声明的读取缺口或解析失败。Utility Worker MUST NOT 仅凭读取到的文本自行把 Capsule 判为 partial。partial Capsule SHALL 列出精确可读范围、缺口、最后一个完整事件、未闭合动作、逐项来源与 unknowns；当 transcript 不可用时，Recovery SHALL 以 transcript_unavailable 失败。Utility Worker MUST NOT 递归触发新的 Recovery，但在同一 Recovery Operation 内 MAY 被安全重派一次，再次失败则该 Recovery 失败。替代 Session 启动前 SHALL 通过角色门：Specification Planner 要求已落盘的 Specification Unit 不含隐藏决定；Implementation 要求 workspace、HEAD 与 dirty paths 可对账且无未知外部副作用；Validator 要求识别缺口后判断相关 Evidence 是否失效并重新验证；Finalizer MUST NOT 需要 Capsule，而 SHALL 从权威输入重跑只读检查。

对于 Codex Worker Harness，Adapter 只有在 SessionStart 报告于当前 Dispatch 时间窗内提供 provider session ID、Codex 状态根目录与 transcript 路径，且候选唯一、rollout 文件名中的 ID、首条 `session_meta.id`、上报 session ID 三者一致、`session_meta.cwd` 等于绑定 workspace 时，才 SHALL 签发 `transcriptRef`。任一事实缺失、冲突或出现多候选时 SHALL 返回 `transcript_unavailable`；MUST NOT 按 mtime、模糊 cwd 或“最新文件”降级匹配。

Codex Worker 的状态根目录 SHALL 是位于该 Worker worktree 内、随 worktree 一并回收的隔离 `CODEX_HOME`。项目 trust SHALL 只写入该状态根的临时 `config.toml`；Companion 只有在核验 SessionStart hook 来源后才 MAY 把 hook trust bypass 固定进 Codex launcher。Worker Harness Adapter SHALL 以封闭的 prepared-terminal 策略准备 Codex，Application SHALL 等待该 terminal 可接管后调用 Orca `worker-start --terminal`；只有已读回非空 draft 时 MAY 以固定 Enter 补交一次，并仅在 Orca 读回 exact Worker 后把它视为正式 Dispatch。系统 MUST NOT 为此写入用户级 Codex `config.toml`、修改 Orca 全局 Agent 默认参数或环境、向调用方开放任意 shell/env/argv/文本输入，或把尚未被 Orca 接管的 terminal 当作 Worker。Companion 创建的 external terminal SHALL 在 Dispatch 结算后显式关闭；状态不明时 SHALL 阻塞而不是重复准备。

#### Scenario: 完整 Capsule

- **WHEN** Utility Worker 能够完整读取中断 Segment 的 transcript
- **THEN** 系统生成 complete Capsule，并在角色门通过后启动替代 Session

#### Scenario: 部分 Capsule

- **WHEN** Adapter 已证明精确 transcript 存在可定位的读取缺口或解析失败，且 Utility Worker 只能读取其可用部分
- **THEN** 系统生成 partial Capsule，列出精确可读范围、缺口、最后完整事件、未闭合动作、逐项来源与 unknowns，并仅在该缺口满足角色门时继续

#### Scenario: Utility Worker 不能自行声明 partial

- **WHEN** Utility Worker 报告 partial，但 Adapter 没有给出对应的读取边界或解析失败证据
- **THEN** 系统拒绝该 Capsule，且不把 Worker 自报的缺口当作 transcript 事实

#### Scenario: transcript 不可用

- **WHEN** 中断的 Session Segment 缺少可用 transcript
- **THEN** 系统以 transcript_unavailable 判定该 Recovery 失败并阻塞，而不是猜测上下文

#### Scenario: prepared-terminal 无法形成可核验 Dispatch

- **WHEN** Codex prepared-terminal 的准备、idle、Orca 接管、exact Worker 读回或后续清理任一环节无法核验
- **THEN** 系统失败关闭并保留或阻塞对应资源 lane，不修改用户级 Codex 配置或 Orca 全局 Agent 默认值，不把未接管 terminal 当作 Worker，并保持真实 Recovery 验收未完成

#### Scenario: Utility Worker 重派一次仍失败

- **WHEN** 受限 Utility Worker 未能在首次尝试生成 Capsule，且在同一 Recovery Operation 内被安全重派一次后仍失败
- **THEN** 该 Recovery 判定失败，系统不递归启动第二个 Recovery

#### Scenario: Finalizer 的恢复

- **WHEN** 需要恢复中断的 Finalizer Session
- **THEN** 系统不生成 Capsule，而由替代 Session 从权威输入重跑只读交付检查
