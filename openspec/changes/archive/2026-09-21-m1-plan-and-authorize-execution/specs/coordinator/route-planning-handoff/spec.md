## Purpose

定义 Route Planning Session 之间与 Route Planning 到 Execution Coordination 的两类责任转移：规划 Session 的 prepare→review→cutover 交接及其失败恢复，以及进入 Execution Coordination 的门禁、Lease 交接与模式切换。

## ADDED Requirements

### Requirement: Handoff gate, mode transition and execution lease

Coordination Scope SHALL 显式持久化 `route_planning` 与 `execution_coordination` 两种模式，暂停、阻塞、取消与 Replanning Transition SHALL 作为正交控制状态存在，且 SHALL NOT 被表达为第三种模式或 Session 级模式；进入 Execution Coordination SHALL 要求开放 Decision Ticket 与 fog 均清空、无未决交互或未完成 mutation、Implementation Plan 绑定当前地图 revision、Graph Compiler 接受候选图、且用户已批准完整 Execution Authorization Manifest；切换成功时模式、当前 Graph Generation 与 Orca Run、Execution Authorization、预算引用与 Execution Coordination Lease SHALL 一并生效，Lease SHALL 由唯一 Coordinator Session 持有并 SHALL 在 Runtime Incarnation 退出后可恢复。

#### Scenario: 模式随 Scope 而非 Session 变化
- **WHEN** 一个 Coordinator Session 进入或离开规划
- **THEN** Scope 的模式 SHALL 保持显式记录，Session 的创建、定位或退出 SHALL NOT 隐式改变它

#### Scenario: 控制状态不伪装成模式
- **WHEN** Scope 被暂停、阻塞或取消
- **THEN** 这些 SHALL 作为与模式正交的控制状态记录，模式值 SHALL 保持不变

#### Scenario: 存在开放票据时不切换
- **WHEN** 仍有开放 Decision Ticket 或 fog
- **THEN** 模式 SHALL 保持 `route_planning`，SHALL NOT 切换、SHALL NOT 建立 worktree 或物化任何 Work Package

#### Scenario: 编译未通过时不切换
- **WHEN** Graph Compiler 未接受候选图
- **THEN** 切换 SHALL 被拒绝并报告编译结论，候选图 SHALL 保持惰性

#### Scenario: 缺少批准时不切换
- **WHEN** 用户尚未批准完整 Manifest
- **THEN** 切换 SHALL 被拒绝，SHALL NOT 出现任何 Worker 派发或 worktree 建立

#### Scenario: 只有一个 Session 持有 Lease
- **WHEN** 切换完成后另一个 Coordinator Session 尝试物化任务或消费生命周期事件
- **THEN** 该 Session SHALL 只能观察，SHALL NOT 推进图、消费事件或花费共享预算

#### Scenario: Lease 持有者退出后可恢复
- **WHEN** 持有 Execution Coordination Lease 的 Runtime Incarnation 退出
- **THEN** 该 Lease SHALL 能被按既有恢复路径重新取得，SHALL NOT 自动转移给其他 Session

#### Scenario: Lease 过期不释放其他所有权
- **WHEN** Execution Coordination Lease 失效
- **THEN** Session 的 Ticket Claim 与已记录预算 SHALL 保持不变

### Requirement: Route Planning session handoff

Route Planning 的 Session 间交接 SHALL 遵循 prepare、review、cutover 三阶段：prepared Session 产出并持久化交接提案，接收 Session 在 review 阶段独立复核提案，cutover 阶段才把 Route Planning 责任转移给接收 Session；交接 SHALL 只转移 Route Planning 责任，SHALL NOT 释放、停止或重新归属 Execution Coordination 下已在途的 Worker 及其 Dispatch。

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

### Requirement: Handoff resilience and activation gate

交接 SHALL 在取消、提案过期与进程崩溃后可被确定性处理；在任何未决交接期间，接收 Session SHALL NOT 激活规划动作，除非满足 `awaiting_user_prompt` 激活门。

#### Scenario: 取消交接恢复原责任方
- **WHEN** 用户或原责任方在 cutover 之前取消交接
- **THEN** Route Planning 责任 SHALL 保持或回到原 Session，交接提案 SHALL 标记为已取消，SHALL NOT 留下半转移状态

#### Scenario: 过期提案不进入 cutover
- **WHEN** 提案引用的地图 revision、计划 revision 或候选图在 cutover 前发生变化
- **THEN** 提案 SHALL 被判定为过期，cutover SHALL 被拒绝并要求重新 prepare，SHALL NOT 以过期提案转移责任

#### Scenario: 崩溃后按持久阶段恢复
- **WHEN** 交接期间进程崩溃并重启
- **THEN** 系统 SHALL 从持久化的交接阶段确定性恢复：prepare 未完成则回到原责任方，review 已完成而 cutover 未完成则等待明确的 cutover 决定，已完成 cutover 则保持接收 Session 为责任方

#### Scenario: awaiting_user_prompt 激活门
- **WHEN** 存在未决交接且尚未满足 `awaiting_user_prompt` 激活门
- **THEN** 接收 Session SHALL NOT 执行规划动作、SHALL NOT 修改 Route Map，并 SHALL 以等待用户输入的状态呈现；激活门后 SHALL 才允许推进规划
