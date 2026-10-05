## MODIFIED Requirements

### Requirement: Resumption requires admitted Actionable Work

模型恢复 SHALL 只由 durable Actionable Work 触发；当前 Worker 的问题、升级与需模型判断的已结算失败或项目交付结论 SHALL 归属于持有该责任的 Session，经来源身份和版本核验后持久准入，并 SHALL 在恢复前以稳定 batch 身份同步写入恰好一个 Wake Batch；已提交的 Wake Batch SHALL NOT 被重复注入模型历史。

#### Scenario: 无 Actionable Work 时不唤醒
- **WHEN** 仅发生普通进度、keepalive、长轮询超时或无变化对账
- **THEN** 模型 SHALL NOT 被恢复，Session SHALL 保持挂起

#### Scenario: Wake Batch 先落盘再恢复
- **WHEN** Controller 判定存在 Actionable Work 并准备恢复模型
- **THEN** 它 SHALL 先取得 Runtime Lease、收集有界 Actionable Work、以稳定 WakeBatchId 写入 checkpoint，再记录 source admission 并调用模型循环

#### Scenario: 重复恢复不重复注入
- **WHEN** 进程在写入 Wake Batch 之后、模型恢复之前中断并再次启动
- **THEN** 该 batch SHALL 按稳定 source revision 与 batch ID 补齐，已提交的 batch SHALL NOT 被再次注入模型历史

#### Scenario: Worker 问题与升级唤醒责任方
- **WHEN** 当前 Run、Task、Dispatch、Attempt 与真实发送方精确匹配的普通问题或升级到达
- **THEN** 来源先准入责任方的 Wake Batch 再确认消费，仅在控制状态与交接门允许时恢复模型

#### Scenario: 已结算交付结论需要说明
- **WHEN** Finalizer 结论或确定失败已持久结算且需要 Coordinator 判断或向用户说明
- **THEN** 责任方沿稳定来源身份准入一次 Wake Batch，重启或重复对账不重复注入

#### Scenario: 旧尝试和确定性验证步骤不唤醒
- **WHEN** 到达旧 Attempt 消息或同 Session 验证序列的结构化步骤报告
- **THEN** 前者仅补历史，后者走受控步骤续接，均不作为普通 Worker 问题恢复模型
