## Why

本轮复核发现多条已定义的协调用例未进入生产调用链：重规划、Validator 修复、预算扣减、Worker 唤醒与维护无法形成端到端闭环，Claim 和阻塞状态也缺少持久约束。实现已按用户授权修复，但缺少对应 change，且三个主规格仍有与已恢复并行额度矛盾的条款；本 change 补齐这轮工作的一致性与追踪记录。

## What Changes

- 接通 Replanning Transition、候选审阅与 Generation Cutover、取消恢复，以及从 Git/Orca 回读旧成果采用和 lineage 预算继承事实。
- 接通独立 Validator 同 Session 验证、范围内修复与复验，以实际 Git 变更校验范围，持久记录步骤与结果结论。
- 将 Implementation Attempt 和 Validator 修复准入与预算消费绑定，稳定重放不重复计费，Retry 保持原 Task、契约、授权与 profile。
- 强制每个 Scope/Session 最多一个活跃 Ticket Claim；规划交接原子转移 Claim 与规划责任，执行交接原子转移 Claim、Lease、相关交互与执行责任，执行接收方等待用户 Prompt。
- 接通 Worker 问题、升级和需模型判断的已结算结果唤醒；接通有限定时维护、provider 原生压缩能力和无进展时一次 Shake 的持久限制。
- 持久化 checkpoint 不可恢复的 Session blocker；执行 Lease holder 损坏时同时阻塞 Scope。凭据实例统一由 bootstrap 注入。
- 同步前台执行、Specification Revision 与 TUI monitoring 的并行条款；更新架构合同及两个 SQLite store 的模型绑定职责。
- Branch Store 升至 schema 20；既有重复活跃 Claim 阻止迁移且整体回滚，不自动删改所有权。

## Capabilities

### New Capabilities

无；复用现有 capability。

### Modified Capabilities

- `coordinator/foreground-execution-runtime`: 有界并行角色推进、实现尝试的有限且幂等消费。
- `execution/specification-revision`: 修订持有不冻结无关并行包。
- `tui/execution-monitoring`: 完整活动包、批准额度与串行集成队列投影。
- `execution/validation`: 实际工作区修复核验与稳定步骤预算消费。
- `planning/route-map`: 每个 Session 的单活跃 Claim 约束。
- `coordinator/route-planning-handoff`: 规划交接的 Claim 与规划责任原子转移。
- `coordinator/execution-handoff`: 执行交接的 Claim 与用户 Prompt 激活门。
- `coordinator/wake-suspension`: Worker 与结算来源的 owner-scoped 唤醒。
- `coordinator/session-runtime`: checkpoint 不可恢复时可恢复查询的持久 blocker。

`execution/replanning`、`coordinator/context-maintenance`、`configuration/model-settings` 和 `coordination/branch-state` 的现有相关 Requirements 保持，实施与证据映射纳入 implementation-plan。

## Impact

直接前驱：已归档 `restore-configurable-execution-concurrency`；基线 HEAD：`88d908ae2d5e7d798e207875242df72394cee274`。范围为 M1/M2 的现有 Ubuntu 前台闭环，涉及 domain、application、storage/agent/Orca adapters、bootstrap、只读投影、相关测试及文档；不增加依赖。

本次是对已授权、已实现但尚未提交的工作补录，不归档、不提交、不创建正式 verification。真实 Orca/provider 集成验收尚未执行，普通测试的跳过不视为真实证据。后台运行、远程控制、新 Harness、发布与部署不在范围内。
