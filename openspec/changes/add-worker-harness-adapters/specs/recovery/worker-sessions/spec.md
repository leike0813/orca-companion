## MODIFIED Requirements

### Requirement: Worker Session Recovery 先尝试精确恢复且不得凭不完整信息推断退出

Worker Session Recovery SHALL 是 Worker Harness session 中断后的唯一恢复生命周期，适用于 Specification Planner、Implementation、Validator、Finalizer 以及 Recovery Utility、Baseline Planner、Graph Patch Planner 等所有派发 Worker Session 的角色；Coordinator Session 的恢复 MUST NOT 走该生命周期。系统 SHALL 先按原 Session Binding 与该角色绑定的 harness adapter 精确恢复原会话；当存活或身份证据不充分时，系统 SHALL 判定为 unverifiable，并 MUST NOT 据此推断该会话已退出、已失败或需要重新派发。

#### Scenario: 可精确绑定的中断

- **WHEN** 中断的 Worker Harness session 能按精确 Session Binding 与记录的 Worker Attempt 对应
- **THEN** 系统先尝试由该 harness adapter 精确恢复原会话，而不是直接创建替代 Session

#### Scenario: 存活不可判定

- **WHEN** 无法充分证明该 Worker Harness session 仍存活或已退出
- **THEN** 系统把其标记为 unverifiable，并保持未决，不推断退出也不触发重复派发

#### Scenario: Coordinator Session 中断

- **WHEN** Coordinator Session 本身中断
- **THEN** 系统按其自身 checkpoint 与启动对账处理，不创建 RecoveryId、Session Segment 或 Recovery Capsule

#### Scenario: 四主角色之外的 Worker 同样适用

- **WHEN** Recovery Utility、Baseline Planner 或 Graph Patch Planner 的 harness session 中断
- **THEN** 系统按同一生命周期尝试精确恢复，并保留其原 Task 与 profile 绑定

### Requirement: Recovery Capsule 必须由受限 Utility Worker 生成且按角色门判定

Recovery Capsule SHALL 由一个受限 Utility Worker 通过 Task Envelope 从精确 transcript 提取产生，其结论 SHALL 为 complete 或 partial。Worker Harness Adapter SHALL 提供与 Dispatch、Session Binding 绑定的可寻址 transcript 材料及读取覆盖证据；来源 MAY 是 Orca provider transcript，也 MAY 是 harness 自己证明的 transcript。`transcript_unavailable` SHALL 表示没有经证明的可寻址 transcript；partial SHALL 仅表示精确 transcript 中存在 Adapter 已定位并声明的读取缺口或解析失败。Utility Worker MUST NOT 仅凭读取到的文本自行把 Capsule 判为 partial。partial Capsule SHALL 列出精确可读范围、缺口、最后一个完整事件、未闭合动作、逐项来源与 unknowns；当 transcript 不可用时，Recovery SHALL 以 transcript_unavailable 失败。Utility Worker MUST NOT 递归触发新的 Recovery，但在同一 Recovery Operation 内 MAY 被安全重派一次，再次失败则该 Recovery 失败。替代 Session 启动前 SHALL 通过角色门：Specification Planner 要求已落盘的 Specification Unit 不含隐藏决定；Implementation 要求 workspace、HEAD 与 dirty paths 可对账且无未知外部副作用；Validator 要求识别缺口后判断相关 Evidence 是否失效并重新验证；Finalizer MUST NOT 需要 Capsule，而 SHALL 从权威输入重跑只读检查。

Worker Harness Adapter SHALL 按 harness 提供可核验的 transcript 证明：claude 以 SessionStart hook 上报的 session id 与精确 transcript path 为准；pi 以原生 `session_start` extension 上报的 session id、transcript path 与 active branch header 为准；omp 以 extension 等待真实 session 文件出现后回读的 exact session id 与 fullpath 为准；opencode 以隔离 `--standalone` 私有子进程的公开 session metadata 与 `/api/session/:sessionID/message` 的 limit/cursor 分页读取范围为准，MUST NOT 直接打开其 SQLite 存储或按终端输出推断。任一事实缺失、冲突、候选不唯一或观察窗口不匹配时 SHALL 返回 `transcript_unavailable`；MUST NOT 按 mtime、模糊 cwd 或「最新文件」降级匹配。

Worker 的状态根 SHALL 位于该 Worker worktree 内、随 worktree 一并回收的隔离目录；只读角色的状态根 SHALL 位于 Git common dir 的 Companion 私有目录。项目 trust、hook 与 extension 注册 SHALL 只写入该隔离状态根；Worker Harness Adapter SHALL 以封闭的 prepared-terminal 策略准备 harness，Application SHALL 等待该 terminal 可接管后调用 Orca `worker-start --terminal`；只有已读回非空 draft 时 MAY 以固定 Enter 补交一次，并仅在 Orca 读回 exact Worker 后把它视为正式 Dispatch。系统 MUST NOT 为此写入用户级 harness 配置、修改 Orca 全局 Agent 默认参数或环境、向调用方开放任意 shell/env/argv/文本输入，或把尚未被 Orca 接管的 terminal 当作 Worker。Companion 创建的 external terminal SHALL 在 Dispatch 结算后显式关闭；状态不明时 SHALL 阻塞而不是重复准备。

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

#### Scenario: 非 Codex harness 的 transcript 逐项证明

- **WHEN** 中断 Session 来自 claude、opencode、pi 或 omp
- **THEN** Adapter 只在该 harness 的 id、path/metadata 与观察窗口逐项一致时签发 transcriptRef，否则以 transcript_unavailable 阻塞

#### Scenario: prepared-terminal 无法形成可核验 Dispatch

- **WHEN** prepared-terminal 的准备、idle、Orca 接管、exact Worker 读回或后续清理任一环节无法核验
- **THEN** 系统失败关闭并保留或阻塞对应资源 lane，不修改用户级 harness 配置或 Orca 全局 Agent 默认值，不把未接管 terminal 当作 Worker，并保持真实 Recovery 验收未完成

#### Scenario: Utility Worker 重派一次仍失败

- **WHEN** 受限 Utility Worker 未能在首次尝试生成 Capsule，且在同一 Recovery Operation 内被安全重派一次后仍失败
- **THEN** 该 Recovery 判定失败，系统不递归启动第二个 Recovery

#### Scenario: Finalizer 的恢复

- **WHEN** 需要恢复中断的 Finalizer Session
- **THEN** 系统不生成 Capsule，而由替代 Session 从权威输入重跑只读交付检查
