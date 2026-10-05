## Purpose

定义 Coordination Scope 内的并发控制契约：以短租约和递增 fencing 代数保证同一 Session 只有一个活跃运行时、执行协调只有一个 lease holder，并让迟到的进程写入被明确拒绝而不是静默覆盖。

## Requirements

### Requirement: Runtime Lease 生命周期与 fencing

store SHALL 为每个 Coordinator Session 提供短 Runtime Lease，由持有者心跳续约，并 SHALL 维护单调递增的 fencing generation；新运行时取得租约后，旧代际的写入 SHALL 被拒绝。Runtime Lease 过期 SHALL NOT 释放该 Session 的 Ticket Claim 或 Execution Coordination Lease，这些所有权 SHALL 只通过完成、显式释放或用户授权转移而改变。

#### Scenario: 过期租约被接管

- **WHEN** 一个 Session 的 Runtime Lease 已过期且未被续约
- **THEN** 新的 Runtime Incarnation SHALL 能取得租约并获得更大的 fencing generation

#### Scenario: 迟到进程写入被拒绝

- **WHEN** 被取代的运行时以旧 fencing generation 提交写入
- **THEN** store SHALL 拒绝该写入，且 SHALL NOT 修改当前状态

#### Scenario: 运行时退出后 claim 保留

- **WHEN** 一个 Session 的 Runtime Incarnation 退出且租约过期
- **THEN** 其 Ticket Claim SHALL 仍然有效，SHALL NOT 被自动释放

#### Scenario: 恢复沿用原所有权

- **WHEN** 同一 Session 的后续运行时取得租约
- **THEN** 它 SHALL 继承原有 claim 与 lease 关系，SHALL NOT 重新申领

### Requirement: Execution Coordination Lease 唯一持有者

在一个 Coordination Scope 内，Execution Coordination Lease SHALL 同时只由一个 Coordinator Session 持有；其他 Session SHALL 能观察执行状态但 SHALL NOT 物化任务、消费生命周期事件、消耗共享预算或应用图变更。

#### Scenario: 非持有者不得推进执行

- **WHEN** 非持有者 Session 请求应用图变更或消耗共享预算
- **THEN** store SHALL 拒绝该请求

#### Scenario: 持有者唯一

- **WHEN** 两个 Session 在同一 Scope 内竞争 Execution Coordination Lease
- **THEN** 只有一个 SHALL 取得租约，另一个 SHALL 得到明确拒绝

### Requirement: Atomic Work Package lane admission
唯一 Execution Coordination Lease holder SHALL 按当前批准的并行包额度推进多个独立 Work Package，每包 SHALL 最多有一个在途角色 Worker。建立外部资源前 SHALL 原子占用额度，派发尚不可见、角色交接、恢复和待集成 SHALL 继续占用。unknown SHALL 沿原身份对账，只有可证明的完成或终止 SHALL 释放额度。

#### Scenario: Concurrent callers cannot oversubscribe
- **WHEN** 多个调用者争用最后一个额度
- **THEN** 至多一个新包 SHALL 被接纳，其余调用 SHALL 不建立外部资源

#### Scenario: Restart before worker observation
- **WHEN** 派发已接受但 Worker 列表尚不可见时进程重启
- **THEN** 原包 SHALL 继续占用额度，恢复 SHALL 不重复派发

#### Scenario: Prepared terminal title changes
- **WHEN** terminal-create 已被接受而 shell 或 TUI 改写显示标题
- **THEN** 恢复 SHALL 使用原创建回执的精确句柄，并在原 worktree 内重新核验资源；缺原句柄或资源失效 SHALL 阻塞所属 lane，不能重复创建或按标题猜身份

### Requirement: Lane-local blockers
包级未知、恢复和修订 SHALL 仅冻结受影响包及依赖后继，独立包 SHALL 继续推进。全局共享事实不可证明及 Scope 控制 SHALL 保持全局门禁。

#### Scenario: One blocked lane
- **WHEN** 一个包的外部操作未知但其他独立包的事实完整
- **THEN** 其他包 SHALL 在额度内继续工作