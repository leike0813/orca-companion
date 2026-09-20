## Context

直接前驱 `m1-admit-work-package-specifications` 交付的接缝：`src/domain/dispatch-candidate.ts` 的物化前置判定、`src/domain/task-contract.ts` 与 `src/domain/worker-report.ts` 的 Task Envelope 与候选报告类型、`src/domain/worker-liveness.ts` 的三值存活与可核验终态判定、`src/application/specification-admission.ts` 的接纳与 Spec Binding、`src/adapters/agents/session-binding.ts` 为四角色提供的精确 Session Binding、可引用 transcript 与中断 Segment 事实，以及 `src/adapters/orca-cli/orca-backend.ts` 对既有 `ExecutionBackend` 联合的实现。

CONTEXT.md 已定义本 change 的全部领域词汇（Accepted Worker Result、Validator、Validation Attempt、Session Segment、Evidence Record、Retry Attempt、Revised Worker Task、Integration Operation、Unattributed Drift、Delivery Verdict、Finalizer、Execution Coordination Lease）。设计只补充实现层选择。

M0 冻结的 Orca 事实：Dispatch 与 Attempt 是运行事实，`worker_done` 是唯一终态收据，`consumer_generation` 在重挂载时自增并隔离前任消费者，`request-show` 的 `absent` 不构成未发生的证据。

### 架构合同导入

| 关系 | 合同 | 本 change 的责任 |
|---|---|---|
| Create | IC-08 Delivery settlement、Validation 与 Git Integration；FLOW-03 | 唯一拥有正常 Delivery 结算顺序、结果核验、Validator 同会话链与授权内集成 |
| Extend | IC-03 BranchCoordinationStore | 只增加 Delivery 去重键、Accepted Worker Result 引用与分支级 Delivery Verdict 最小记录 |
| Consume | IC-01、IC-02、IC-05、IC-06、IC-07；FLOW-01 | 复用 operation、transport、授权、规格与 Worker 合同；不复制其字段或状态机 |

Accepted Worker Result 正文始终归 Orca；本 change 不实现 Worker Session Recovery，也不生成任何 Capsule。

## Goals / Non-Goals

**Goals:**

- 把结果核验、证据失效、集成前置与交付结论实现为可测试的普通 TypeScript 规则，复用前驱的类型与端口而不新建状态机。
- 让「实现完成」「验证通过」「项目可交付」三个事实在类型与用例层面无法互相推出。
- 保持所有 Git 与 Orca 副作用具备稳定 OperationId 与对账路径。
- 保证 Validator 的「验证—修复—复验」只在同一真实 session 内连续执行，session 丢失时只进入 blocker 或正常 Retry Attempt。

**Non-Goals:**

- 物化时机、Specification Admission 与 Spec Binding（前驱 change）。
- Graph Patch/Revision、Replanning、Baseline Adoption 与 Migration Material（后继 change）。
- Worker Session Recovery、Recovery Capsule 生成与 Recovery Budget 计数（直接后继 Change 7 `m1-recover-execution`）。
- TUI 呈现、取消与暂停语义、远程 attach 与无人值守运行。
- 第二套重试策略或通用工作流引擎。本 change 通过前驱 migration 机制增加 Delivery 去重与分支级 Verdict 的最小记录，不另建数据库。

## Decisions

### D1: 结果核验实现为单一纯函数，输入为报告与当前代际事实

在 `src/domain/` 新增 `worker-result-verification` 模块，输入为候选报告与前驱定义的当前 Run、consumer generation、Task、Dispatch、Attempt、角色、Specification Revision 与 worktree 事实，输出为 `accepted | stale-generation | rejected(reason)`。应用层只在得到 accepted 时写入 Accepted Worker Result。替代方案是在 adapter 内判断，被否决：代际与角色是领域规则。

### D2: Accepted Worker Result 归 Orca，本地只保存去重键与引用

核验通过后，应用层通过既有 `ExecutionBackend` 的 `task-update`/Delivery receipt 路径把归一化结果提交给 Orca，并回读 Task、Dispatch、Attempt 与 receipt；只有 Orca 确认记录后才形成 Accepted Worker Result。Branch Coordination Store 只保存稳定 Delivery 去重键与 `AcceptedWorkerResultRef`，不保存结果正文或复制 Orca 状态。替代方案是把归一化结果写进本地结果表，被否决：AGENTS.md §8 把 Accepted Worker Result 归给 Orca。

正常 Delivery 顺序由本 change 唯一拥有：调用 M0 的读取原语但不 ack → 校验身份与当前代际 → 查去重键 → 在 Orca 写入并回读 Accepted Worker Result → 持久化去重键与引用并回读 → 调用 M0 的 ack 原语。后继 Recovery 只补启动重放、unknown 对账和冻结代际处理，不重新实现该顺序。

### D3: 三个事实以独立的判别联合表达，不用布尔组合

`src/domain/work-package-status.ts` 定义实现状态、验证状态与交付状态三个独立字段类型，不提供任何由一个推出另一个的转换函数。替代方案是单一 phase 枚举，被否决：单一枚举会天然蕴含推导关系，正是规格禁止的。

### D4: Retry Attempt 只创建新 Dispatch/Attempt，不触碰 contract

应用层在判定结论性失败后调用既有 `startWorker` 端口并传入 `--retry-of` 语义的 Dispatch 引用，同时复用前驱的预算记录，不做预算归零。需要改变 contract 时不进入本路径，返回一个显式的「需要契约修订」结论交给后继 change 的修订路径。替代方案是让重试顺带刷新 contract，被否决：那会让修订与重试混为一谈。

### D5: Validator 验证链必须复用同一真实 session

应用层在「验证—修复—复验」序列内复用前驱精确绑定的同一 harness session。原 session 丢失时，当前 Validation Attempt 立即停止推进并形成 blocker；仅当 D4 的正常 Retry Attempt 条件成立时，才以新 Dispatch 与新 Attempt 开始独立尝试。Session Segment 只是前驱留下的中断事实，不能授权继续原 Attempt。替代方案包括新起 session 继续原 Attempt、生成 Capsule、消耗 Recovery Budget，均留给 Change 7，不在本 change 实现。

### D6: 修复范围检查复用已有授权与 Scope Envelope 类型

修复前调用一个纯函数判定改动路径集合是否落在该 Worker Task 已授权范围与 Scope Envelope 内，并单独累计修复预算。越界时返回需要 Worker Escalation 的结论，不进入「验证通过」分支。替代方案是把范围检查放在 Worker 侧，被否决：Worker 自审不能替代 Controller 的确定性检查。

### D7: 证据失效以受影响路径集合判定，粒度沿用前驱

沿用前驱 Evidence Record 的 worktree 相对路径集合语义，修复触及任一覆盖路径即失效。已知上限与升级路径沿用前驱 design 的记录，不在此重复设计更细的判定。

### D8: Git 集成实现为固定顺序的 Integration Operation

顺序为：核验 Validator 接受状态与 Lease 持有 → 核验 Git Integration Policy（remote、ref、普通 commit）→ 持久化 Operation Intent 与 expected HEAD → 执行 commit → 集成 canonical 分支 → 推送获批 remote/ref → 回读核验 → 完成 Intent。任一步 unknown 时以同一 OperationId 对账。替代方案是复用 shell，明确否决：§5 禁止任意 shell。

### D9: Unattributed Drift 检查在每次派发前执行

派发用例在调用前驱的判定函数之前，先比对当前 canonical HEAD 与最近一条已完成 Integration Operation 的 expected HEAD；无法归属即返回暂停结论。替代方案是定期对账，被否决：派发前的同步检查已经能阻止错误动作，定时对账属于投机基础设施。

### D10: Finalizer 以新的只读 Session 派发，并复用 Session Binding

通过前驱的 `session-binding` 与 `startWorker` 端口派发一个项目级 Worker Task，权限限定为只读；Delivery Verdict 作为结构化报告经前驱的报告校验入口归一后再由本 change 的判定函数接受。替代方案是复用某个 Validator 会话，被否决：§7 要求 Finalizer 使用新的只读项目级 Session。

### D11: 交付结论不写回任何既有权威记录

接受 Delivery Verdict 时只写入一条新的分支级结论记录，不修改 Execution Graph、Accepted Worker Result、Git 历史或 Operation Intent。替代方案是把结论写进图节点，被否决：§8 禁止伪造与改写既有权威事实。

## Risks / Trade-offs

结果核验依赖 `consumer_generation` 与 Attempt 事实的准确性，测试必须先以 fake backend 覆盖旧代际与旧尝试两类路径。Validator 的会话复用依赖 Orca 能持续证明同一 session；该证明丢失时本 change 只能阻塞或按正常 Retry Attempt 重开，因此长验证可能等待 Change 7 才具备跨 session 恢复能力。Unattributed Drift 检查以 HEAD 比对实现，在并发外部提交场景可能频繁触发暂停；这是保守方向的误报，优先于静默推进。Delivery Verdict 的接受依赖 Finalizer 报告可结构化，若只读 Session 无法产出结构化载荷，则必须先补齐报告通道再启用该能力，不得降级为纯文本判定。
