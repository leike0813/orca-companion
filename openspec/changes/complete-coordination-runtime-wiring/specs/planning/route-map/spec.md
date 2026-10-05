## MODIFIED Requirements

### Requirement: Ticket Claim binds a ticket to one Session

一个开放 Decision Ticket SHALL 同时最多由一个 Coordinator Session 持有；同一 Scope 内一个 Coordinator Session SHALL 同时最多持有一个活跃 Ticket Claim；Claim SHALL 由 tracker assignee 与该 Session 的本地记录共同表达，并 SHALL 在 Runtime Incarnation 退出后继续存活。

#### Scenario: 已认领票据不出现在 Frontier
- **WHEN** 一个开放未阻塞票据已被某 Session 认领
- **THEN** 该票据 SHALL NOT 出现在其他 Session 的 Frontier 中

#### Scenario: 进程退出不释放认领
- **WHEN** 持有 Claim 的 Runtime Incarnation 退出
- **THEN** Claim SHALL 保持，只有完成、显式释放或用户授权转移才改变持有者

#### Scenario: 已持票 Session 再认领另一张票
- **WHEN** Session 已持有一个活跃 Claim，即使两张票的 tracker assignee 是同一协调身份
- **THEN** 第二次认领被拒绝且原 Claim 保持不变；原 Claim 完成或释放后才可认领其他票
