# coordinator/foreground-execution-runtime Specification

## Purpose
定义当前 Ubuntu 前台进程如何把已批准的执行计划接入真实 Worker 生命周期，并在退出、重启与外部结果不确定时保持唯一责任、可恢复性和可观察性。

## Requirements

### Requirement: Implementation Attempt 的准入消费有限且幂等

每次新的 Implementation Attempt SHALL 在允许派发前消费一次绑定授权的实现预算；同一 Attempt 的恢复或重放 MUST NOT 重复扣减。确定失败后的 Retry SHALL 沿原 WorkerTask、contract、revision、授权与 Worker Profile 建立新 Dispatch/Attempt，并消费新尝试额度；unknown MUST 按原操作身份对账，MUST NOT 当作新尝试重派。预算耗尽 SHALL 阻塞实现派发，重启、重新授权和重规划延续旧责任 MUST NOT 重置已消费额度。

#### Scenario: 确定失败重试直至额度耗尽
- **WHEN** 某包的实现 Attempt 确定失败且原授权仍有效
- **THEN** 有额度时新 Attempt 使用原 Task 和运行依据；无额度时保持阻塞，预算详情显示真实累计消费

#### Scenario: 准入后中断再恢复
- **WHEN** 同一 Attempt 已准入并消费预算，进程在派发结果核验前中断
- **THEN** 恢复沿原身份对账，既不重复扣减也不创建第二个 Dispatch

### Requirement: 授权切换由当前规划事实驱动

前台 Controller SHALL 从当前地图、票据、计划、图、Scope 与用户批准的完整 Manifest 装配切换事实；门禁通过后 SHALL 原子进入 Execution Coordination。任一引用失效或未获批准时 MUST NOT 进入执行模式或派发 Worker。

#### Scenario: 批准后进入执行
- **WHEN** 当前规划产物完整、Manifest 已按当前图版本批准且切换门禁通过
- **THEN** Scope 进入 Execution Coordination，持有唯一 Execution Coordination Lease，并出现当前 Graph Generation 的执行视图

#### Scenario: 规划引用过期
- **WHEN** 批准后地图或候选图版本发生变化
- **THEN** 切换被拒绝，旧批准不触发 Worker 派发

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

### Requirement: Delivery 与 Worker Session Recovery 驱动可恢复进度

前台 Controller SHALL 消费当前 Run 的 Delivery 与 Worker 状态，按权威身份接纳结果；只有结果与本地引用均持久化并回读后才确认 Delivery。Worker Session 丢失时 SHALL 按原 Attempt 的 Recovery 规则处理，并把 Capsule coverage 或明确 blocker 作为可观察事实。

#### Scenario: 当前 Validator 完成并修复复验
- **WHEN** 独立 Validator 在授权范围和预算内修复后于同一真实 Session 复验通过
- **THEN** 当前 Work Package 显示已接受的验证结果与有效证据，旧证据失效，集成才可开始

#### Scenario: 旧代际消息晚到
- **WHEN** 已冻结 Graph Generation 或旧 Attempt 的 Delivery 到达
- **THEN** 该消息只补历史并被安全确认，不唤醒当前代际或推进当前 Work Package

#### Scenario: Session 无法恢复
- **WHEN** 精确 transcript 不可用或 Recovery Budget 已耗尽
- **THEN** 当前派发保持阻塞，界面显示原因；不得伪称原 Session 已续接

#### Scenario: 结果还在未确认 Delivery 上
- **WHEN** 某个已退出的 Worker 仍有未确认 Delivery，且其归属与已记录派发逐项一致
- **THEN** 该会话不被当作丢失：宿主结算那条 Delivery，而不是为它启动或续办 Recovery

#### Scenario: 原会话结果已结算
- **WHEN** 一条非终结 Recovery 的同角色同 Attempt 结果已经结算
- **THEN** 该 Recovery 以 `source_completed` 收口并 supersede 原 Segment，不派发 Utility Worker，也不占住替代派发 lane

### Requirement: 工具状态不是项目改动

前台 Controller SHALL 只把项目路径当作 Work Package 的实现范围与工作区变化：Worker Harness 与 agent 工具在工作区内维护的状态目录（`.agents/`、`.codex/` 等，由工具自己写技能、报告与会话材料）MUST NOT 构成 Scope Envelope 越界证据，MUST NOT 让 canonical 工作区被算作不干净，也 MUST NOT 参与 Finalizer 的运行前后比较。项目文件仍 SHALL 落在 Scope Envelope 内。

#### Scenario: Validator 报告写在工具状态目录
- **WHEN** Validator 在工具状态目录里留下报告，项目内没有越界改动
- **THEN** 该结果按正常路径通过核验并结算，不被判为越界

#### Scenario: 项目内的越界改动
- **WHEN** 某次结果涉及的 dirty paths 里有落在 Scope Envelope 之外的项目文件
- **THEN** 该结果仍被拒绝并列出越界路径

### Requirement: 重启与 Scope 控制先对账

前台进程 SHALL 在恢复执行派发前对账未决操作、未确认 Delivery、Worker liveness 与未完成 Recovery。Resume SHALL 在对账完成后才恢复调度。Cancel SHALL 在取消意图落盘后请求停止当前 Worker，并只根据可核验 stop verdict 推进控制状态；Exit SHALL 只退出前台进程。

#### Scenario: 活跃 Worker 后重启
- **WHEN** 进程退出时 Worker 仍可能运行，随后从同一 Scope 重启
- **THEN** 首次新派发前可见对账状态；同一 Task、Dispatch、Attempt 不被重复创建

#### Scenario: Resume 对账仍不确定
- **WHEN** 用户请求 Resume 且存在无法确认的 Worker 或操作
- **THEN** 恢复被阻止，相关 lane 与原因可见；未知不被报告为已退出

#### Scenario: Cancel 停止结果不确定
- **WHEN** 用户请求 Cancel 且 Worker stop verdict 无法核验
- **THEN** Scope 保持 cancelling 或 unverifiable，重启后继续按原操作身份核验

### Requirement: 集成后才产生项目级终态

当前 Lease 持有者 SHALL 仅集成 Validator 已接受的 Work Package，并从 Git 与 Orca 权威事实验证结果。全部 Work Package 集成完成后 SHALL 在已冻结集成的 canonical worktree 派发新的只读 Finalizer Session，并比较运行前后 HEAD、index 与 dirty paths；只有独立结论被接受后才呈现 deliverable。

#### Scenario: 集成成功后派发 Finalizer
- **WHEN** 所有 Work Package 验证与集成均完成，且无未决交互或 mutation
- **THEN** Finalizer 在只读约束下检查项目，界面显示运行前后工作区与项目级 Evidence

#### Scenario: 只读或工作区无法核验
- **WHEN** 只读权限无法强制或 Finalizer 运行期间工作区发生变化
- **THEN** 交付保持 blocker，界面不显示 deliverable

#### Scenario: 集成结果不确定
- **WHEN** Git 步骤超时或 canonical HEAD 与预期不符
- **THEN** 受影响集成 lane 保持阻塞，后续派发与 Finalizer 不继续

#### Scenario: Worker 已自行提交交接成果
- **WHEN** commit 步执行时 Worker worktree 的 HEAD 已不等于所记录 expected HEAD，但能证明它是该 HEAD 的后继
- **THEN** 该步按「已经提交」继续并回读当前 HEAD；只有无法证明后继关系（例如历史被替换）时才以 `source_head_mismatch` 拒绝

### Requirement: Delivery 载荷的两条形状都由已记录事实定归属

前台宿主 SHALL 接受两种 Delivery 载荷：带 Companion 归属字段与结果正文的 Companion 形状，以及真实 Codex Worker 投递的 Orca 规范形状（`taskId`/`dispatchId`/`outcome`/`filesModified`，叙述在 `body`）。Orca 规范形状 SHALL 只用作 locator：归属由 `materialization_bindings.orcaTaskId` 与 Session Segment 解析，两者逐项一致才放行；解析不到或逐项不一致时 MUST 阻塞该 Delivery，不得按「最接近的一条」匹配，也不得要求 Worker 回显 Companion 身份。

#### Scenario: Orca 规范载荷进入结算
- **WHEN** 当前 Run 收到一条 Orca 规范形状的 `worker_done`，且其 `taskId`/`dispatchId` 与已记录的物化绑定、Session Segment 逐项一致
- **THEN** 该 Delivery 进入同一结算 pipeline（身份/代际核验 → Orca 接受与回读 → ack），结果正文归一化为状态、改动清单与叙述

#### Scenario: locator 定位不到
- **WHEN** Orca 规范载荷的 `taskId` 或 `dispatchId` 没有对应的已记录派发
- **THEN** 该 Delivery 被阻塞并给出原因，不产生结算、不推进生命周期

### Requirement: 放宽 Worker 沙箱必须由已批准的 Manifest 承担

角色级 Worker Session 的 Codex 沙箱模式 SHALL 来自版本化项目配置，并且只有在该模式被设为 `danger-full-access` 时要求 `acceptedRisks` 显式包含对应风险。授权审阅 SHALL 把该模式与风险作为 Manifest 的一部分呈现给用户；未接受风险时 MUST NOT 产生可批准的 Manifest。角色级派发与替代 Session SHALL 只使用**已批准 Manifest** 携带同一风险的沙箱模式；Finalizer 的只读模式 MUST NOT 受该配置影响。

#### Scenario: 未接受风险的放宽
- **WHEN** 项目配置把沙箱设为 `danger-full-access`，但 `acceptedRisks` 没有对应风险
- **THEN** 授权审阅以结构化 blocker 阻塞，不产生授权记录，也不做任何外部 mutation

#### Scenario: 审批与运行一致
- **WHEN** 用户批准了携带该风险的 Manifest
- **THEN** 角色级派发按该模式运行，且审阅里可见的沙箱模式与实际派发策略一致；审批之后单独改配置不会悄悄改变运行策略
