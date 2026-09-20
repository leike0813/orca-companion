# coordinator/context-maintenance Specification

## Purpose
定义 Coordinator 模型输入的有界化方式、原生压缩与 Capsule 的优先次序、checkpoint 中两类产物的分离保存，以及上下文无法安全收敛时的显式关闭行为。

## Requirements

### Requirement: Bounded model input with separated checkpoint artifacts

当已提交历史使模型输入超出有界范围时，Session SHALL 用派生的 Context Capsule 表示更早的消息区间，checkpoint SHALL 继续保留该区间的底层完整对话，Capsule SHALL 以可移植、可读的结构化文本表达，且 checkpoint SHALL 将 Native Compacted Window 的 owner metadata 与可移植 Capsule 分开保存。

#### Scenario: 被取代区间的原始消息仍可恢复
- **WHEN** 一段较早的消息区间被 Context Capsule 取代后 Session 恢复
- **THEN** checkpoint SHALL 仍能读回该区间的原始已提交消息，模型输入 SHALL 只包含 Capsule 与保留区间

#### Scenario: 两类产物分开保存
- **WHEN** 一个 Session 同时存在 harness 原生压缩窗口与派生 Capsule
- **THEN** checkpoint SHALL 分别保存原生窗口的 owner metadata 与 Capsule 内容，任一方的缺失或不可用 SHALL NOT 损坏另一方

#### Scenario: Capsule 不成为业务权威
- **WHEN** Capsule 内容与 tracker、Git 或 Orca 的事实不一致
- **THEN** 权威 SHALL 仍以对应系统为准，Capsule SHALL NOT 被当作状态或证据的权威副本

#### Scenario: 重新注入上下文
- **WHEN** Session 在压缩或恢复之后继续模型调用
- **THEN** system 与 project instructions、tool schema 以及最新权威事实 SHALL 按当前配置重新注入，SHALL NOT 沿用被压缩区间中的旧副本

### Requirement: Native-first compaction with opaque native window and explicit degradation

压缩 SHALL 优先使用 provider-native 压缩；provider-native 不可用时 SHALL 回退到 Context Capsule；两者都不足以恢复有界输入时 MAY 执行一次机械 Shake；若仍无法收敛，Session SHALL 以显式 `compaction_degraded` 或 `context_exhausted` 状态结束本次处理。

#### Scenario: 原生压缩可用时优先使用
- **WHEN** 当前 provider 支持原生压缩且压缩触发
- **THEN** Session SHALL 使用原生压缩路径，SHALL NOT 先执行 Capsule 或 Shake

#### Scenario: 原生不可用时回退 Capsule
- **WHEN** provider-native 压缩不可用
- **THEN** Session SHALL 回退到派生 Context Capsule，SHALL NOT 以超出窗口的原始历史继续请求

#### Scenario: 一次机械 Shake 作为最后手段
- **WHEN** 原生压缩与 Capsule 都未能恢复有界输入
- **THEN** Session MAY 执行一次不带模型调用的机械 Shake，且 SHALL NOT 在未取得新进展时重复执行

#### Scenario: 无法收敛时显式降级或耗尽
- **WHEN** 上述路径都无法把模型输入带回到有界范围
- **THEN** Session SHALL 以显式 `compaction_degraded` 或显式 `context_exhausted` 状态结束本次处理并给出可诊断原因，SHALL NOT 静默丢弃对话、伪造摘要或继续超窗请求

#### Scenario: 原生压缩项原样往返
- **WHEN** 一次模型调用返回 provider 原生压缩项
- **THEN** Companion SHALL 只记录该项的身份与位置，并在后续请求中原样携带，SHALL NOT 解析、改写或依据其内容改写 Session 状态

#### Scenario: 原生项不可用时阻塞而非降级
- **WHEN** 之前记录的原生压缩项无法再被原样携带，且不存在可用的 Capsule 迁移路径
- **THEN** Session SHALL 阻塞并记录原因，SHALL NOT 用自行构造的内容替代该不透明项

### Requirement: Context failure fails closed

当模型输入无法安全有界化时，Session SHALL 进入显式阻塞状态并给出可诊断原因，且 SHALL NOT 静默丢弃对话、伪造摘要或继续使用超出窗口的输入。

#### Scenario: Capsule 无法生成时阻塞
- **WHEN** Context Capsule 无法从已提交历史生成，且不存在其他安全的有界输入方式
- **THEN** Session SHALL 阻塞并记录原因，模型循环 SHALL NOT 以截断或伪造的历史继续，SHALL NOT 创建替代 Coordinator Session 或转移 Ticket Claim 与 Execution Coordination Lease

#### Scenario: 出现无法安全归类的历史项
- **WHEN** 历史中出现 Companion 无法安全归类或安全裁剪的项
- **THEN** Session SHALL 阻塞并保持原状，SHALL NOT 猜测裁剪边界
