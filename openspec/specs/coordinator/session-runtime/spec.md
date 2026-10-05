# coordinator/session-runtime Specification

## Purpose
定义 Coordinator Session 的模型 loop 宿主、会话状态归属与单写者运行时约束，使一个 Session 能在进程重启后以同一身份恢复，并拒绝第二个写者。

## Requirements

### Requirement: Coordinator Session checkpoint isolation

每个 Coordinator Session SHALL 在独立的 checkpoint 线程中持久化自身的已提交消息、tool step 与图位置，且 SHALL NOT 与其他 Coordinator Session 共享同一线程。

#### Scenario: 同一 Scope 内两个 Session 互不可见
- **WHEN** 同一 Coordination Scope 内存在两个 Coordinator Session 并各自推进模型循环
- **THEN** 重启后每个 Session SHALL 只读回自己的已提交消息与图位置，任一 Session 的写入 SHALL NOT 改变另一个 Session 的可读状态

#### Scenario: 会话状态不含凭据与业务权威
- **WHEN** 写入一次 Session checkpoint
- **THEN** 持久化的会话状态 SHALL 只包含可 JSON 序列化的对话与 loop 进度，且 SHALL NOT 包含 provider 凭据、Orca 运行事实或 Route Map 内容

### Requirement: Single live Coordinator Runtime Incarnation

一个 Coordinator Session SHALL 同时最多有一个存活的 Runtime Incarnation；当 Runtime Lease 由存活进程持有时，其他进程 SHALL 在写入 checkpoint 或执行任何副作用之前被拒绝。

#### Scenario: 并发进程启动同一 Session 被拒绝
- **WHEN** 第二个进程尝试以同一 Coordinator Session 身份启动，而 Runtime Lease 仍由存活 incarnation 持有
- **THEN** 第二个进程 SHALL 以显式拒绝结束，且 SHALL NOT 写入 checkpoint、消费 Delivery 或发起外部 mutation

#### Scenario: 被 fence 的迟到进程写入被拒绝
- **WHEN** 一个 fencing generation 低于当前代际的进程尝试提交 checkpoint 或 Operation Intent
- **THEN** 该写入 SHALL 被拒绝，当前 incarnation 的持久状态 SHALL 保持不变

### Requirement: Committed model step and durable resumption identity

模型循环 SHALL 只在一次 Coordinator Agent 响应及其 tool calls 被原子接受为 Committed Model Step 之后才继续下一步；恢复 SHALL 沿用原 Coordination Scope、Coordinator Session、Planning Cycle 与已消耗预算。模型响应与工具结果 SHALL 从该 Session 最新的已提交状态追加，并校验稳定条目身份；写入期间已受理的其他条目（例如新的用户消息）MUST NOT 被旧快照覆盖或丢失。

#### Scenario: 未完整提交的响应不进入历史
- **WHEN** 一次模型响应在中途中断
- **THEN** 该响应 SHALL NOT 成为已提交历史的一部分，重启后模型循环 SHALL 从最后一次 Committed Model Step 之后继续

#### Scenario: 恢复不创建新身份
- **WHEN** 同一 Coordination Scope 的 Session 在进程重启后恢复
- **THEN** SHALL 复用原 Coordinator Session 身份、Planning Cycle 与已消耗预算，且 SHALL NOT 隐式创建新的 Session、Planning Cycle 或运行身份

#### Scenario: checkpoint 不可恢复时 fail closed
- **WHEN** 现有 Session 的 checkpoint 损坏或无法读回，且没有其他方式恢复同一会话
- **THEN** Session SHALL 持久保存 blocked 生命周期及结构化原因并可在重启后查询；若该 Session 持有 Execution Coordination Lease，Scope SHALL 同时进入持久 blocked 控制状态；SHALL NOT 创建替代 Coordinator Session、SHALL NOT 以空历史继续、SHALL NOT 转移 Ticket Claim 或 Execution Coordination Lease

#### Scenario: checkpoint blocker 重启后仍存在
- **WHEN** checkpoint 损坏已经使执行 Lease holder 阻塞，前台退出并重启
- **THEN** Session 与 Scope 的 blocker 保持可查询，模型与新派发不恢复；只有原 checkpoint 经核验可恢复并完成 Resume 对账后才解除阻塞

#### Scenario: 模型等待期间受理的消息不被覆盖
- **WHEN** 一次模型响应或工具结果写入期间，同一 Session 受理了一条新的用户消息
- **THEN** 该消息在写入完成后仍存在于会话历史中，后续模型输入包含它

### Requirement: Durable tool-call execution and result pairing

模型返回的每个受支持 tool call SHALL 在已提交的模型响应之后由受控工具处理，并以原 call 身份记录结果，供下一次模型调用与重启后的会话使用。每次调用 SHALL 重验 Scope、Session、模式、权限、revision 与预算；副作用结果未知时 SHALL 保留原操作身份等待对账，SHALL NOT 换身份重试。未知工具或无法配对的 call SHALL 明确阻塞或返回结构化拒绝，SHALL NOT 静默跳过。

#### Scenario: 工具回合被实际执行

- **WHEN** 模型在一次完整响应中请求受支持的规划工具
- **THEN** 工具 SHALL 被调用，配对结果 SHALL 出现在同一 Session 后续模型输入和 transcript 中

#### Scenario: 响应提交后崩溃

- **WHEN** 模型响应已持久化而工具结果尚未持久化时进程中断
- **THEN** 恢复 SHALL 沿用原 call 与操作身份核验结果，SHALL NOT 重复发起已接受的外部副作用

#### Scenario: 连续工具回合

- **WHEN** 同一 Session 连续完成至少 100 个不同的受控工具调用
- **THEN** 模型 loop SHALL 继续按业务预算处理，SHALL NOT 被固定的低 step 上限提前终止

### Requirement: Incremental authoritative conversation records

Session SHALL 以稳定消息、响应、调用和 Wake 身份增量保存会话记录，正文 SHALL 只有一个权威来源。普通追加、图位置更新、提交核验及工具恢复 MUST NOT 读取或重新序列化整个历史。消息与 Wake、完整响应与调用、结果与处理来源 SHALL 原子提交。身份与内容相同的重放 SHALL 幂等，冲突 SHALL 拒绝并保持原记录。恢复 SHALL 精确读取最后一次响应及配对结果，保持原操作身份和 existing Wake admission 补齐语义。

#### Scenario: 长历史中追加与核验
- **WHEN** 一个 Session 已有大量已提交历史，再提交消息、模型响应或工具结果并核验原 submission
- **THEN** 实际读写 SHALL 只处理本次记录和所需身份，原历史保持不变，模型等待期间受理的消息仍保留

#### Scenario: 原子提交失败与重放
- **WHEN** 提交中途失败，或同身份相同/不同载荷再次提交
- **THEN** 失败 SHALL 不留下半条消息或半个 Wake；相同载荷不重复，不同载荷拒绝，跨库中断按原 Wake 身份补齐

#### Scenario: 精确工具恢复
- **WHEN** 响应已提交、部分工具已完成且进程重启
- **THEN** SHALL 以原 call/operation 身份只续办未配对调用，unknown 保持未知，已完成工具不重新调用

### Requirement: Streaming model response isolation

生产模型调用 SHALL 消费真实流式响应，临时预览 SHALL 与 Committed Model Step 隔离；完整响应经可信身份、fencing 和原子提交接受后才执行工具。Scope Cancel SHALL 在保存取消意图后停止活跃模型调用；Exit SHALL 停止前台调用但不改变 Scope 控制状态，Pause SHALL 保留在途调用。输出超限、取消和 fencing SHALL NOT 重试或写入部分历史；普通模型故障保持既有有限重试。

#### Scenario: 分片工具调用
- **WHEN** tool call 参数跨多个 chunk 返回
- **THEN** SHALL 仅在完整响应接受后以可信 step/call/operation 身份执行，chunk 和预览不成为工具执行依据

#### Scenario: 中断与租约失效
- **WHEN** 生成期间输出超限、Scope Cancel、前台退出或 Runtime 被 fence
- **THEN** 活跃调用 SHALL 停止，部分响应不提交，取消/超限/失效不被普通模型重试重新启动

#### Scenario: 预览存储不可用
- **WHEN** 临时文件/预览容量不足或预览观察者失败
- **THEN** 预览 SHALL 明确不可用，模型完整响应仍可按原提交合同接受；预览故障不重复模型调用

### Requirement: Verified streamed usage

流式 usage SHALL 只在取得可确认的完整报告时保存。多个 usage 片段的归约语义无法从通用合同确认时 SHALL 保存 null 并显示不可用，MUST NOT 猜测累计/增量规则、估算或加入 provider 特判。

#### Scenario: 完整与不明确 usage
- **WHEN** 一个完整 usage 报告随响应返回，或多个非空 usage 片段需要不明确的合并
- **THEN** 前者保存实际报告，后者保留 null；缺失值不被填零或作为费用事实

### Requirement: Bounded trusted call inspection

Session SHALL 提供按可信 step/call/operation 身份关联的有界调用清单和参数/结果范围读取，正文仍只有一个权威来源。只读详情与搜索 SHALL 不启动模型、执行工具或产生业务动作，MUST NOT 先完整读取/解析巨大参数再裁切。历史关联索引 SHALL 可从原记录重建并受有限批次约束。unknown SHALL 来自绑定原调用身份的真实结构化观测；观测不成为已完成结果，不改变原操作对账或恢复身份。

#### Scenario: 巨大参数与原文来源
- **WHEN** 一个已提交调用包含超过一次范围预算的参数或结果
- **THEN** 详情和搜索按完整字符边界读取原来源的有限范围，不复制全文为UI历史或发送日志

#### Scenario: unknown与未确认
- **WHEN** 真实工具调用返回unknown，或结果尚未取得/写入
- **THEN** 前者记录可信未知观测，后者保持未确认，不从缺失或自由文案猜unknown；已有配对结果仍优先，恢复不重复已完成工具

#### Scenario: 索引补齐与重放
- **WHEN** 打开已有保留历史或重放同一提交
- **THEN** 关联按有限批次补齐，原参数/结果不改写，相同身份不重复产生调用或活动
