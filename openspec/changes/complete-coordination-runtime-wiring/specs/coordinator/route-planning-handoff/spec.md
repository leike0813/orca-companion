## MODIFIED Requirements

### Requirement: Route Planning session handoff

Route Planning 的 Session 间交接 SHALL 遵循 prepare、review、cutover 三阶段：prepared Session 产出并持久化交接提案，接收 Session 在 review 阶段独立复核提案，cutover 阶段才把 Route Planning 责任与 Source 的活跃 Ticket Claim 原子转移给接收 Session；Target 已有另一活跃 Claim 时 SHALL 拒绝整个 cutover 并保持 Source 所有权；交接 SHALL 只转移 Route Planning 责任，SHALL NOT 释放、停止或重新归属 Execution Coordination 下已在途的 Worker 及其 Dispatch。

#### Scenario: prepare 阶段只产出提案
- **WHEN** 一个 Route Planning Session 进入 prepare 阶段
- **THEN** 它 SHALL 持久化交接提案并保持自身仍为当前规划责任方，SHALL NOT 提前把责任标记为已转移

#### Scenario: review 阶段独立复核
- **WHEN** 接收 Session 进入 review 阶段
- **THEN** 它 SHALL 独立复核提案所引用的地图 revision、开放票据、计划工件与候选图状态，复核未通过时 SHALL 保持原责任方并报告原因

#### Scenario: cutover 才转移责任
- **WHEN** review 通过且进入 cutover 阶段
- **THEN** Route Planning 责任 SHALL 转移到接收 Session 并持久化，原 Session SHALL NOT 继续推进规划，SHALL NOT 同时存在两个规划责任方

#### Scenario: 交接不触碰执行中的 Worker
- **WHEN** 交接发生时 Scope 内存在 Execution Coordination 下已派发的 Worker
- **THEN** 该 Worker、其 Dispatch、Task 与授权状态 SHALL 保持不变，交接 SHALL NOT 停止、释放或重新归属它们，也 SHALL NOT 改变 Execution Coordination Lease 的持有者

#### Scenario: 接收方已有活跃 Claim
- **WHEN** 已通过 review 的交接试图把 Source 的活跃 Claim 转给已持有另一 Claim 的 Target
- **THEN** cutover 整体拒绝，规划责任与 Claim 均保留在 Source
