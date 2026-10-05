## RENAMED Requirements

- FROM: `### Requirement: 前台进程串行推进角色工作`
- TO: `### Requirement: 前台进程有界并行推进角色工作`

## MODIFIED Requirements

### Requirement: 前台进程有界并行推进角色工作

前台 Controller SHALL 仅由当前 Execution Coordination Lease 持有者推进 Execution Frontier；每次只物化当前候选的一个角色级任务，并按 Planner、Specification Admission、Implementation、Validator 的现有门禁推进。并行包额度 SHALL 来自已批准 Manifest 的 `maxActiveWorkPackages`，默认 3，接受任意正安全整数；各包使用隔离 worktree，同包角色与 canonical 集成 SHALL 分别串行。降低额度后在途包 SHALL 继续，空槽回收至新额度后再接纳新包。Pause、Cancel、失去租约或相关未决 mutation SHALL 阻止新的派发。

#### Scenario: 首个候选进入执行
- **WHEN** 已授权图有多个满足依赖的候选且没有活跃 Work Package
- **THEN** Controller 逐次物化当前候选的角色级 Task，并在批准额度内接纳多个独立包；额度已占满的候选保持等待

#### Scenario: 角色结论推进下一个角色
- **WHEN** 当前角色的结果已被核验并接受，且其后继门禁通过
- **THEN** Controller 为同一 Work Package 派发下一个角色；其他依赖已满足的包可在批准额度内推进

#### Scenario: Planner 的产出位置与结构由 Envelope 明示
- **WHEN** Controller 为 Specification Planner 组装 Task Envelope
- **THEN** Envelope 携带固定 `specificationUnitPath` 与三条产出纪律（写在固定路径、单元必须含 `specs/`、不得自行归档或改名），因为这些是宿主该说清的事实，Worker 不应通过猜测或自选约定来满足 Admission

#### Scenario: 派发结果不确定
- **WHEN** 物化或 Worker 启动的结果无法核验
- **THEN** 当前 mutation lane 保持阻塞，重启后只按原操作身份对账，不生成第二个 Task 或 Dispatch

## ADDED Requirements

### Requirement: Implementation Attempt 的准入消费有限且幂等

每次新的 Implementation Attempt SHALL 在允许派发前消费一次绑定授权的实现预算；同一 Attempt 的恢复或重放 MUST NOT 重复扣减。确定失败后的 Retry SHALL 沿原 WorkerTask、contract、revision、授权与 Worker Profile 建立新 Dispatch/Attempt，并消费新尝试额度；unknown MUST 按原操作身份对账，MUST NOT 当作新尝试重派。预算耗尽 SHALL 阻塞实现派发，重启、重新授权和重规划延续旧责任 MUST NOT 重置已消费额度。

#### Scenario: 确定失败重试直至额度耗尽
- **WHEN** 某包的实现 Attempt 确定失败且原授权仍有效
- **THEN** 有额度时新 Attempt 使用原 Task 和运行依据；无额度时保持阻塞，预算详情显示真实累计消费

#### Scenario: 准入后中断再恢复
- **WHEN** 同一 Attempt 已准入并消费预算，进程在派发结果核验前中断
- **THEN** 恢复沿原身份对账，既不重复扣减也不创建第二个 Dispatch
