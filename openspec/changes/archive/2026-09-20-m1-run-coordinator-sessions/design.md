## Context

本 change 直接前驱是 `m1-persist-coordination-state`，它已实现 `coordination.sqlite` 侧的 Branch Coordination State：CAS revision、Runtime Lease 与 fencing、Operation Intent、Session registry。本 change 只补 Coordinator Session 自身的会话运行时，不重新定义这些共享事实。

仓库现状：`src/workflow/` 只有占位文件；`CONTEXT.md` 已固定 Coordinator Session、Coordinator Session Suspension、Wake Batch、Actionable Work、Context Capsule、Coordinator Session State、Committed Model Step、Loop Stall 与 Coordinator Profile 的语义；`docs/research/agent-loop-termination-and-stall-detection.md`、`docs/research/codex-context-compaction-behavior.md` 与 `docs/research/omp-shake-compaction-recovery.md` 给出停机、无进展、原生压缩与机械压缩的一手结论；`AGENTS.md` 第 2、4、8、11 节固定了技术栈、模块边界、状态权威与验证标准。

术语状态：`CONTEXT.md` 与 `AGENTS.md` 目前写作 Coordinator Profile。本 change 的 Canonical 术语是 Coordinator Model Configuration，二者指同一概念；apply 阶段负责把两个文档同步到新术语，起草阶段不编辑它们。

### 架构合同导入

| 关系 | 合同 | 本 change 的责任 |
|---|---|---|
| Create | `IC-04`、`FLOW-02` | 首次实现 Session checkpoint、Wake admission、Actionable Work、suspend 与 Context maintenance |
| Extend | `IC-03` | 只增加 `wake_admissions` 与 Session runtime 所需最小记录，复用同一 store/migration seam |
| Consume | `IC-01`、`IC-02` | 沿用 Session/Operation identity 与 intent/unknown 对账 |
| Consume | `MOD-02`、`MOD-03`、`MOD-04` | LangGraph 只编排 Application，用独立 checkpoint adapter 保存会话状态 |

## Goals / Non-Goals

**Goals:**

- 让一个 Coordinator Session 能在进程重启后以同一身份恢复对话与 loop 进度。
- 让模型 loop 的挂起与恢复由 durable 事实驱动，而不是进程存活与否。
- 让模型输入保持有界，同时保留 checkpoint 中的完整已提交历史。
- 让模型配置切换成为一个可判定、可恢复的显式动作。

**Non-Goals:**

- 不实现 TUI、CLI 交互与 Pending Interaction 呈现。
- 不实现 Worker 派发、Task Envelope、Worker Result 验收。
- 不实现 Route Planning 语义操作、Execution Graph 编译与 Execution Authorization。
- 不实现通用上下文压缩服务，也不把 Companion 变成 provider 网关。

## Decisions

### D1 会话状态权威落在独立 checkpoint store

Coordinator Session State 由 LangGraph 的 Session checkpointer 持久化到 Git common dir 下的 `checkpoints.sqlite`，与直接前驱的 `coordination.sqlite` 分离。`durability: sync`，图状态在每个 super-step 边界同步提交。

理由：`AGENTS.md` 第 8 节已固定两个独立 SQLite store 的归属；前驱已声明 CAS 与 Operation Intent 在 coordination store 侧。共享事实不复制进 checkpoint，checkpoint 也不成为业务权威。

备选：把会话状态并入 coordination store（否决，会让两类写入互相阻塞并混淆权威）；用 `MemorySaver`（否决，重启即失，违反可恢复要求）。

### D2 Session 身份即 checkpoint thread

Coordinator Session 身份是一个稳定 Session ID，直接作为 LangGraph `thread_id`。同一 Scope 内不同 Session 使用不同 thread，不同 Session 的 checkpoint 互不可读。

理由：`CONTEXT.md` 已规定 Session 之间不共享 checkpoint；一个稳定 ID 让恢复不需要重新解析「属于谁」。

### D3 单写者由前驱 Runtime Lease 与 fencing 承担

本 change 不新建互斥机制。写入 checkpoint 与发起任何副作用之前，Runtime Incarnation 必须持有前驱提供的 Runtime Lease，并携带当前 fencing generation；被 fence 的写入被拒绝。

理由：避免第二套锁。前驱已实现 CAS revision 与 fencing generation，这里只做调用方。

### D4 模型调用是图内节点，业务规则留在普通模块

`src/workflow/` 只承载 StateGraph 的节点与边、checkpoint 读写与恢复；准入、状态转换、预算与副作用策略留在 `src/application/` 与 `src/domain/`。图节点不得自行重启整张图，也不得复制领域规则。

理由：`AGENTS.md` 第 4 节明确 LangGraph 只拥有模型循环与对话恢复。

### D5 suspend 结束 loop，Controller 继续运行

无 Actionable Work 时，图在一次 `suspend` 处结束本次 invoke 并返回控制权；Controller 保持前台运行，继续做 Delivery 消费与确定性对账。恢复由 Controller 取得 lease 后重新 invoke 同一 thread 完成。

理由：`AGENTS.md` 第 8 节要求 suspend 不停止前台；`CONTEXT.md` 把 Suspension 定义为模型循环停止而非进程停止。

### D6 维护 lane 是 best-effort 且有界

挂起期间允许在 Runtime Lease 与当前 fencing generation 有效的前提下执行 best-effort keepalive，用于维持缓存与连接，不用于推进业务。维护受有限 maintenance cycle 上限约束；出现 Actionable Work 时立即让位；Scope 进入 Pause 或 Cancel 时停止且不再发起新的 keepalive。

维护动作不得创建 Wake Batch、不得记为 Committed Model Step、不得写入用户可见 transcript、不得改变图位置。lease 丢失或 generation 落后时维护静默停止，不得尝试重新获取。

理由：`docs/research/omp-shake-compaction-recovery.md` 第 10 节记录的有界保活先例（固定次数上限、真实工作即重置、超出档位不保活）；`AGENTS.md` 第 8 节要求普通进度与 keepalive 不唤醒模型。

### D7 Wake Batch 先落盘，再恢复模型

恢复前，Controller 以稳定 WakeBatchId 把有界 Actionable Work 的 source 引用同步写入 Session 历史，随后通过 Branch Coordination Store 的 `wake_admissions` 记录 source revision 与 batch ID，再调用模型循环。该表由本 change 使用前驱迁移机制新增；已提交 batch 不得重复注入。

理由：checkpoint 与 coordination store 不跨库原子；按稳定 source revision 与 batch ID 补齐是唯一不做假事务的路径。

### D8 Actionable Work 由 application 层投影

Actionable Work 是 owner-scoped 投影，只包含需要 Coordinator Agent 判断或模型可见动作的新的 Authoritative Fact 与 Control Record。进度更新、keepalive、长轮询超时与无变化对账被排除。

理由：`AGENTS.md` 与 `CONTEXT.md` 已给出该定义；把它实现成投影而非队列，避免出现通用 inbox。维护 lane 与 Actionable Work 的优先级也由此确定：维护永远是让位方。

### D9 压缩路径按原生、Capsule、机械 Shake 的次序

触发压缩时先尝试 provider-native 压缩；原生不可用则回退到派生 Context Capsule；两者都不足以恢复有界输入时允许一次不带模型调用的机械 Shake；仍无法收敛则以显式 `compaction_degraded` 或 `context_exhausted` 结束本次处理。

机械 Shake 只替换重量级内容为可恢复占位符，不调用模型；未取得新进展时不得重复执行。

理由：`docs/research/codex-context-compaction-behavior.md` 说明原生路径是整窗口替换且由 provider 能力决定；`docs/research/omp-shake-compaction-recovery.md` 说明机械压缩在模型不可用或已溢出时仍可行，且以「是否真的产生空间」而非重试次数决定是否推进。

### D10 checkpoint 分开保存两类压缩产物

checkpoint 把 Native Compacted Window 的 owner metadata 与可移植 Context Capsule 分字段保存，两者互不损坏。原生项保持不透明，Companion 只记录身份与位置。

理由：原生窗口绑定 provider 身份与代际，Capsule 是可移植派生视图；混存会让一方不可用时另一方一起失效。

### D11 每次模型调用按当前配置重新注入

压缩或恢复之后，system 与 project instructions、tool schema 以及最新权威事实按当前配置重新注入，不复用被压缩区间中的旧副本。

理由：`docs/research/codex-context-compaction-behavior.md` 记录 Codex 在 PreTurn 与 Manual 路径下让下一次正常 turn 自行重新注入初始上下文；沿用旧副本会让工具契约与事实滞后。

### D12 Coordinator Model Configuration 注入 chat model

`src/adapters/agents/` 从 Coordinator Model Configuration 解析已安装的 provider 集成并构造 chat model 实例，通过依赖注入交给 workflow。Companion 不设 allowlist、不保存密钥、不自动 fallback；模型 id 与选项来自该配置。

理由：`AGENTS.md` 第 2 节；`docs/research/coordinator-agent-loop-foundations.md` 记录裸字符串模型 id 会隐含外部网关依赖，必须显式传入 provider 实例。

### D13 启动前能力核验

M0 的 `src/bootstrap/doctor.ts` 是唯一 doctor 聚合入口；本 change 向其注入模型能力检查，并沿用 `src/interfaces/cli/doctor-command.ts` 的命令分发。doctor 路径与启动路径共用一次能力核验，至少覆盖文本生成、流式输出、tool calling、取消与可用 usage。缺失必需能力时以非零状态拒绝启动。

理由：`AGENTS.md` 第 2 节已固定核验项；把它放在建立 Session 之前，保证不会出现半可用 Session。

### D14 运行中切换只在 suspended 且无在途操作时发生

切换 Coordinator Model Configuration 要求 Session 处于 suspended 且没有模型相关操作在途。切换顺序固定：持久化当前 checkpoint → 清空旧模型相关的 cache 与 maintenance 计划 → 装配新配置并核验 → 生效。切换后不自动 fallback。

#### 不兼容 native window 的处理

若新配置不能原样使用已有 Native Compacted Window，先尝试把该区间迁移为可移植 Context Capsule；迁移成功后按新配置继续，迁移失败则 Session 保持 suspended 或 blocked 并报告原因。

理由：native 窗口与 provider 身份绑定，跨配置直接携带会让请求不可解释；迁移到 Capsule 是唯一不丢失语义的路径。

### D15 模型调用重试边界

自动重试只作用于已证明安全的模型调用；重试策略在 model node 上配置，并关闭内层重复重试以避免次数相乘。`recursionLimit` 只作高位技术保险，不承担业务预算。

理由：`docs/research/agent-loop-termination-and-stall-detection.md` 的 5.1 节；`AGENTS.md` 第 8 节要求不得用技术上限替代业务预算。

### D16 checkpoint 或 Capsule 不可用则 fail closed

checkpoint 损坏或无法读回、且没有其它方式恢复同一会话时，Session 阻塞；Capsule 无法生成时同样阻塞。两种情况下都不得创建替代 Coordinator Session、不得以空历史继续、不得转移 Ticket Claim 或 Execution Coordination Lease。

理由：`CONTEXT.md` 规定 Session 恢复必须保持同一身份，另一 Session 需要显式所有权转移；用替代会话静默接管会让认领与 lease 失去唯一性。

### D17 模块归属与依赖方向

`src/domain/` 定义 Session、Suspension、维护 lane、Wake Batch、Capsule 与 Model Configuration 的领域类型与规则；`src/application/` 提供用例、DTO 与 ports；`src/workflow/` 提供 StateGraph 与节点；`src/adapters/storage/` 实现 checkpoint store 并扩展前驱 coordination store 的 wake admission 记录；`src/adapters/agents/` 实现模型装配；`src/bootstrap/doctor.ts` 聚合环境与模型能力检查；`src/bootstrap/` 负责其余装配与生命周期。依赖只指向内层契约。

理由：`AGENTS.md` 第 4 节逻辑布局。核心入口必须能在不加载 Ink/React 的情况下运行。

### D18 checkpoint 增长与保留

checkpoint 会随会话增长。保留策略按 Session 显式配置，且清理只删除已提交历史中的冗余快照，不改变当前图位置与已提交消息语义。

理由：`docs/research/agent-loop-termination-and-stall-detection.md` 记录官方建议定期清理或设置 retention；不清理会让本地库无界增长。

### D19 真实 provider 冒烟验收的边界

本 change 的验收包含一项显式 MiniMax-M3 冒烟，覆盖 suspend、缩短周期的 keepalive、手动 compact 与 Model Configuration 持久化四个行为。真实调用使用 MiniMax-M3，且只在显式选择的隔离项目与专用身份中运行；未显式选择时该冒烟不执行，也不作为普通 `pnpm test` 的一部分。

真实 provider 的 prompt cache 命中情况只作为观测记录（记录命中与未命中，不写入断言条件），不作为验收门禁：缓存命中取决于 provider 侧策略与计费窗口，超出 Companion 的可控范围。其余确定性行为仍由 fake 覆盖。

理由：`AGENTS.md` 第 11 节要求真实集成测试必须显式选择隔离项目，并要求不精确断言易变的外部事实；prompt cache 命中属于这类外部事实。

备选：把缓存命中作为门禁（否决，会让验收结果随 provider 策略波动而不可复现）。

## Risks / Trade-offs

- 双库写入天然不是跨库原子事务。取舍是按稳定 batch ID 与 source revision 补齐，代价是恢复路径必须显式处理「已写 checkpoint、未记 admission」的中间态。
- 维护 lane 会增加少量后台活动。取舍是它必须 best-effort 且可被抢占、可被 Pause/Cancel 停止，代价是缓存收益不稳定。
- Capsule 会丢失细节。取舍是只在已提交历史之上派生，保留原始消息作为唯一可回退来源。
- 阻塞式 fail closed 会暂停模型循环。这是刻意的：宁可停下等待处理，也不静默丢弃上下文或伪造恢复身份。
- 运行中切换模型会丢掉 native 压缩窗口。取舍是先迁移为 Capsule，代价是迁移期间 Session 不可用。
- 会话库只存执行草稿。若将来需要跨进程保留图内状态之外的事实，必须回到 planning 重新判定权威归属。

## Migration Plan

本 change 首次引入 `checkpoints.sqlite`，由 bootstrap 在首次启动时按受控路径创建；同时通过前驱的版本化 migration 为既有 `coordination.sqlite` 增加 `wake_admissions`，迁移可重入且不改写既有记录。术语迁移（Coordinator Profile → Coordinator Model Configuration）在 apply 阶段随实现一并落到 `CONTEXT.md` 与 `AGENTS.md`，不改变语义。直接前驱已归档、其主规格已生成、`coordination.sqlite` 的 CAS/lease/intent 符号仍与本计划声明一致时，才允许开始实施；不满足任一条即回到规划。

## Open Questions

无。清理阈值、maintenance cycle 上限与 Capsule 目标尺寸属于配置取值，由实现阶段依据实际对话长度测量后写入项目配置，不改变本 change 的契约、方案或任务划分。
