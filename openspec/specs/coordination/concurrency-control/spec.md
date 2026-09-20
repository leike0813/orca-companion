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