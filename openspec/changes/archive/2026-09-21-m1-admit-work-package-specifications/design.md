## Context

直接前驱 `m1-plan-and-authorize-execution` 的产物约定：Authorization Manifest 一次性绑定 Destination、Route Map revision、Implementation Plan revision、Graph Generation、Coordination Scope、baseline HEAD、空 Orca Run、Worker Profiles、权限、预算、workspace 与 Git/Dependency Policy；Graph Compiler 只做确定性结构检查，不评判规划语义。Controller 拥有准入、状态转换、预算和副作用策略；LangGraph 只拥有 Coordinator Session 的模型循环。

冻结的上游接缝按 AGENTS.md 的模块布局落位：`src/domain/`（纯规则）、`src/application/`（用例与 port）、`src/adapters/orca-cli/`（`ExecutionBackend` transport 与能力探测）、`src/adapters/agents/`（Coordinator chat model 与 Worker Harness/session binding）、`src/adapters/specification/`（`SpecificationProvider`）、`src/adapters/storage/`（Branch Coordination Store 与 LangGraph saver）。M0 已冻结 Orca 侧的公开控制事实：物化走 `task-create` 再 `worker-start --task <id>` 的两步路径，mutation 以 `--retry-request` 与 `request-show` 对账，`terminal_handle_stale` 与 `worker_identity_changed` 是硬失败。

CONTEXT.md 已经给出本 change 全部领域词汇（Work Package、Specification Unit、Specification Provider、Task Contract、Spec Binding、Scope Envelope、Specification Admission、Task Envelope、Worker Result、Worker Question、Worker Escalation、Evidence Record、Session Binding、Session Segment）。设计只补充实现层选择，不重复领域定义。

### 架构合同导入

| 关系 | 合同 | 本 change 的责任 |
|---|---|---|
| Create | IC-06 SpecificationProvider 与 Specification Admission | 在 canonical path 创建唯一 provider port、OpenSpec adapter、接纳规则与 Spec Binding |
| Create | IC-07 Worker Harness binding 与 Task Contract | 创建 Task Envelope、候选报告、精确 Session Binding、三值 liveness 与 Session Segment 前置事实 |
| Extend | IC-02 ExecutionBackend | 只增加建立 worktree、创建 Task 与启动 Worker 的封闭 operation variant |
| Extend | IC-03 BranchCoordinationStore | 只增加 `session_segments` 与最小 `materialization_bindings` 记录 |
| Consume | IC-01、IC-04、IC-05；MOD-01、MOD-02、MOD-04；FLOW-01 | 复用 identity、operation、session 与授权合同；不建立平行 backend、store 或状态机 |

## Goals / Non-Goals

**Goals:**

- 把 Work Package 的物化时机、Specification Admission 的确定性检查、Worker 报告契约与 Session Binding 变成可测试的普通 TypeScript 规则，不引入新的状态机或持久化权威。
- 为 Specification Planner、Implementation、Validator 与 Finalizer 固定可引用 transcript、三值 liveness、可核验终态与中断 Segment 事实。
- 让本 change 的规格不依赖尚未归档的主规格，全部以 ADDED Requirements 表达。
- 保持物化路径对 unknown 结果可对账，且任何部分失败都不留残留资源。

**Non-Goals:**

- Validator 的独立验证、范围内修复与复验，Accepted Worker Result 的记录与三值归一（后继 change `m1-execute-and-validate-work-packages`）。
- 实现尝试与 Retry Attempt 的创建、Graph Patch/Revision 与 Replanning（后继 change）。
- Worker Session Recovery、Recovery Capsule 生成与 Recovery Budget 计数（直接后继 Change 7 `m1-recover-execution`）。
- Git 集成、Finalizer Delivery Verdict、TUI 呈现与真实 Orca 端到端验收（后继 change 或 M1 集成验证）。
- 第二份状态机、provider 注册框架或通用调度框架。Session Segment 与 Materialization Binding 使用前驱的版本化 migration 增加最小记录，不另建数据库。

## Decisions

### D1: 物化前置条件由一个纯函数判定

在 `src/domain/` 新增 `dispatch-candidate` 模块，导出一个纯判定函数，输入为 Work Package 的当前 graph 事实、Execution Authorization 引用、共享预算状态与控制状态，输出为 `可物化 | 拒绝(reason)`。应用层用例在调用任何 Orca mutation 之前先调用它。替代方案是在 adapter 内做判断，被否决：预算与授权是领域规则，放进 transport 会让 CLI 层承担策略并难以测试。

### D2: worktree 建立作为物化的第一个副作用步骤，且以重查实现复用

物化用例按固定顺序执行：读取当前事实 → 判定前置条件 → 查该 Work Package 是否已有通过核验的 worktree → 无则建立并核验身份 → 物化角色级 Orca Task。worktree 的存在性通过实时查询仓库与 Orca 事实得出，不把路径复制进本地记录；Materialization Binding 只保存 `WorkPackageId → OrcaTaskId` 与创建 OperationId，可由实时事实重建并可丢弃。替代方案是把 worktree 路径写进 Execution Graph，被否决：Execution Graph 不拥有 Git/Orca 的 worktree 事实。

### D3: 每次 mutation 使用独立 OperationId，unknown 以原 ID 对账

物化走 M0 已冻结的两步路径（`task-create` → `worker-start --task`）。每次外部 mutation 使用自己的稳定 OperationId，并且都先持久化 Operation Intent 再执行；Task 创建成功后先写入 Materialization Binding，再结算该 intent 并启动 Worker。返回 unknown 时只允许以原 OperationId 对账，禁止换 ID 重试。拒绝必须能证明未产生副作用，否则归入 unknown。替代方案是把两步合并为一次调用，被否决：安装版本不支持 `worker-start --spec`。

### D4: Task Envelope 与 Worker 报告以运行时 schema 校验的 DTO 表达

在 `src/domain/` 定义 Task Envelope、Worker Result、Worker Question、Worker Escalation、Evidence Record 的领域类型与角色判别联合；在边界处做运行时 schema 校验（`src/application/` 的 DTO 层），任何来自 Worker 载荷的 scope、身份、Run、consumer generation、operation identity 字段在校验时被丢弃，不进入领域类型。替代方案是信任 Worker 载荷字段，被否决：AGENTS.md 第 5 节明确禁止模型填写这些值。

### D5: Accepted Worker Result 的记录点在本 change 之外

本 change 只实现「报告是候选结果」与校验所需的输入，不落 Accepted Worker Result 的存储写入。理由是记录点绑定 Task/Dispatch/Attempt 与证据失效规则，属于后继 change 的交付与验证职责；本 change 的 spec 只约束候选性，不约束记录时序。后继 change 必须在自己的规格中补齐该记录时序。

### D6: SpecificationProvider 是本 change 唯一新增的外部工具 port

端口定义在 `src/application/ports/specification-provider.ts`，只暴露两个能力：读取一个 worktree 中的工具原生 Specification Unit，以及读取其角色特定工件转换状态。M1 只实现 OpenSpec，落在 `src/adapters/specification/openspec/`。它与既有 ExecutionBackend、BranchCoordinationStore ports 并存；不新增聚合 `ports.ts`。替代方案是定义支持多工具的注册机制，被否决：M1 只有一个产品实现，注册机制属于投机设计。

### D7: Spec Binding 以内容快照摘要稳定身份，不引用可变路径

Spec Binding 记录 Specification Unit 的 worktree 相对路径、provider 标识、内容摘要与版本号。接纳检查重放时以摘要比对，路径只作为定位信息。这样 Contract Revision 改变内容即得到新绑定，Tracking Revision 因摘要变化也产生新绑定，避免用可变路径表达身份。替代方案是记录绝对路径与 mtime，被否决：AGENTS.md 第 6 节明确禁止按 cwd/mtime 推断。

### D8: 四个主要角色的 Session Binding 只接受可证明的 harness 事实

Session Binding 由 `src/adapters/agents/` 的 Worker Harness Adapter 为 Specification Planner、Implementation、Validator 与 Finalizer 产出，字段为角色、harness 标识、session 身份、可引用 transcript 来源与 Observation 时间窗。当 Orca 返回 `worker_identity_changed`，或无法给出 session 身份与 transcript 引用时，adapter 返回不可用结论而不是猜测。替代方案是以终端 handle 或最近输出近似 session，被否决：§6 禁止用 terminal 输出冒充 provider transcript。

### D9: Worker 存活判定以三值类型表达，且默认保守

存活判定实现为返回 `live | exited | unverifiable` 的判别联合，仅在能证明进程存活或执行主机已被列举且明确不含该终端时才给出确定值。默认分支为 `unverifiable`。结算前另行核验终态收据与 Task、Dispatch、Attempt、角色、Session Binding 一致。替代方案是布尔 live 标志，被否决：布尔值无法表达「缺信息」这一必须区分的状态。

### D10: 会话中断只记录 Segment 前置事实

中断时应用层只记录 Session Segment 的角色、Task、Dispatch、Attempt、Session Binding、最后可引用 transcript 位置、中断边界与可核验终态。该记录通过前驱 migration 机制持久化，保证 Change 7 能在重启后读取；它不带 Recovery Budget 计数，不创建替代 segment，不恢复 session，也不生成 Capsule。session 或 transcript 引用丢失时形成 blocker；Change 6 可在自身规格允许时按正常 Retry Attempt 新开 Dispatch 与 Attempt。所有 Worker Session Recovery 行为由 Change 7 实现。

### D11: 接纳失败一律阻塞并保留现场

Specification Admission 失败时不回滚 worktree、不删除未接纳的 Specification Unit、不消耗实现预算；Controller 记录失败项并把该 Work Package 留在未接纳状态，等待新的 Planner 尝试或升级。替代方案是失败即清理 worktree，被否决：清理会破坏审计与后续修订的基础。

## Risks / Trade-offs

物化与 worktree 建立都是真实副作用，测试必须先用 fake backend 覆盖拒绝与 unknown 路径，再在 M0 的隔离项目与专用身份中验证真实契约。Spec Binding 用内容摘要会让 Tracking Revision 也产生新绑定，接纳检查因此需要区分「语义内容变化」与「只改勾选」两种情况，这个区分放在 spec 与实现里必须显式而不是靠启发式。Session Binding 依赖 Codex 托管钩子，若目标环境钩子未安装，adapter 只能返回不可用并阻塞；Change 5 不提供恢复绕行。Evidence Record 的「受影响范围」在 M1 以 worktree 相对路径集合表达，粒度较粗，作为已知上限记录：更细的范围判定等真实使用中出现误报再收紧。
