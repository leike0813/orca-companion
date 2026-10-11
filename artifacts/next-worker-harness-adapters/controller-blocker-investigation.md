# Controller 阻塞：简明说明

记录日期：2026-10-11。**已修复，混合 Controller 真实验收通过，最终结论为 deliverable。**

Command Code 和 Qwen Code 单独运行本来已经通过。把它们交给 Controller 协调时，暴露了消息读取、恢复绑定和重启投影的共享问题。最容易理解的说法是：Worker 做完了工作，但 Controller 有几处读错了身份或仍保留旧状态，因此不肯继续。

| 问题 | 用户看到的现象 | 修复 |
| --- | --- | --- |
| 问题来自 Orca 的 Dispatch 邮箱，Controller 只认终端地址 | Worker 提问被拒绝 | 用公开回执核对 Task、Dispatch 和发送者 |
| 消息确认后只查 inbox | 能看到问题摘要，读不到全文 | 同 Run 有界历史读取，仍核对精确身份 |
| 已退出 Validator 的旧问题仍等回复 | 恢复被旧消息挡住 | 留存步骤引用，不向失效 Dispatch 发许可或扣预算 |
| Capsule 被旧未确认消息挡住 | 已生成恢复摘要，却一直超时 | 查精确 Utility Task/Dispatch；先落盘回读，再走统一消息确认 |
| 替代 Session 启动与报告绑定仍沿原启动路径 | 接管后读不到正确会话 | 传原 Dispatch 引用，先激活，再沿 recovered 记录读取替代 launch 报告 |
| 授权租约没有对齐当前 Runtime | 正常操作报租约过期 | 复用现有租约重指函数 |
| 工作包标题和最终验证证据没完整交给下一步 | Worker 漏需求，或成功后仍无法结算 | 标题进入已有 instructions，最终报告保留完整 evidence JSON |
| 已确认消息、已接受工作仍留下旧阻塞提示 | 工作已经完成，状态却仍显示等待 | 只清除已确认的精确 Delivery lane；终态节点不再投影为等待 |
| 重启只认内存中的 Finalizer | 已有交付结论，却又要求旧启动证明 | 核验原授权、Session、Verdict 与完整结算后复用已完成事实 |

验收确实中断了原 Validator，并通过公开回读证明它已退出。随后生成 Capsule、启动替代 Validator，完成集成和私有 origin 推送，Finalizer 给出 deliverable。同 Scope 重启后，5 个 binding、1 次 Recovery、4 项结算和原预算均保持不变。见[最终真实证据](controller-20261011T085821980Z-89759c30-e5f4-4a09-8624-89e137fe85f5.json)。

只读启动的另一项根因是 bwrap 原先另起系统 Session，Orca 因而认不出前台 Worker。现保留真实前台进程组，用 seccomp 拒绝危险终端注入；仓库、Git 和协调库仍只读。这条生产路径已在真实矩阵验证。

[独立审计](controller-limited-audit-20261011.md)指出的重复 Capsule 确认、关闭后缺退出证明，以及普通结果成功后旧消息阻塞未解除，均已修复。整批消息必须全部消费后才能确认；unknown 沿原 ID 对账。未结算旧 Finalizer 仍需只读证明。

失败现场保留原失败证据，临时终端和 checkout 已存证回收。没有修改 Orca 数据库、伪造身份或回填失败结算。
