## Context

WorkerHarness 已封闭启动、证明、恢复、只读与目录能力，但 bootstrap 仍按名字选择 transcript 身份复核和 Recovery 配方。现有真实矩阵仅含四家且固定旧模型与协议。IC-07 是扩展合同，消费 IC-02/08/09/14；不改变状态权威或预算。

## Goals / Non-Goals

目标：把可实际测试且满足合同的候选接入同一生命周期，以公开原生证据闭合身份、恢复和只读边界。候选全部评估，支持名单由证据确定。非目标：通用插件平台、新协议/角色/状态机、Coordinator 凭据管理、历史迁移、Windows 支持和 ledger-lab 业务变更。

## Decisions

### D-01 候选资格先于正式注册

按 proposal 清单逐项核验原生公开接口，先验证本机七项。CLI 未安装且接口满足时安装官方发行到用户级目录；只追加目标模型配置，不改变原默认或登录。缺 MiniMax 支持、需未提供的付费订阅、无精确恢复、无可寻址原生 transcript、Orca 不识别真实进程或 bwrap 无法隔离时排除并写证据，不留未验收注册。Antigravity 用户登录是独立前置条件，其他候选继续。禁止改 Orca 私有数据、伪造 process/title/Session 或以宽权限代替失败能力。

### D-02 两项能力由 adapter 拥有

WorkerHarness 新增必填 `readTranscriptIdentity({transcriptRef, workspace}): Promise<{providerSessionId:string}|{kind:'transcript_unavailable',reason:string}>` 与 `recoveryInstructions(): readonly string[]`。沿用既有结果与配方文本，bootstrap 只按注册项调用，未知 harness 返回原结构化拒绝。将 Codex/OpenCode 原配方搬入所属 adapter，native 三家沿用已有实现。对真实格式不同的新增项使用独立 adapter，复用现有解析/launcher/helper，仅当格式与语义实际相同才复用解析器。无新持久化字段。

### D-03 原生身份与启动

逐次模型、report/security 设置使用公开 flags/overlay；继承真实 process.env。reporter 只写精确 ID/path/cwd/观察时间与非秘密 runtime roots；身份再由原生 header、metadata 或公开 Session API 独立复核。公开 export/API 可作为精确 transcriptRef 的来源，输出在 Companion 工件中保留其原身份与 coverage；不能将终端流当原生 transcript。调用有界、可取消、参数数组；缺口和歧义按 unavailable，不按最近文件猜。恢复固定原 Task/profile、原 Session 和 runtime roots，新 Dispatch 重新证明同一身份。

### D-04 共享生产安全路径与模型选择

复用生产 bwrap、prepared terminal、OperationOutcome 和原 ID 对账。真实 roots 在 launcher 环境解析，state 可写、仓库/Git/common dir/协调库拒写，根重叠不能证明就阻塞。目录沿既有30秒/4096项/1MiB/20000行边界；无公开无prompt查询可明确 unavailable，手填 exact ID 且 effort/catalogSource 为 null。不从模型名字捏造 effort。配置 schema5/Manifest4/SQLite 不变；TUI 沿 #52，仅增加通过验收的选择。

用户已批准扩大此 change 的共享 launcher 范围：当前 Orca 的真实 foreground 检查与 bwrap `--new-session` 冲突。生产只读启动须保留真实前台进程身份，并以强制 seccomp 禁止终端注入 `TIOCSTI`/`TIOCLINUX` 替代该会话隔离措施；过滤器由 launcher 通过专用继承 FD 交给 bwrap，安装失败或 CPU ABI 不支持时拒绝启动。禁止依赖宿主可变 sysctl、冒用 harness 名称或取消只读挂载。核验真实 ioctl 拒绝、前台进程身份、读写哨兵及现有 harness 回归后方可验收。

### D-05 验收与证据

复用真实矩阵，以每家实际 native modelSelection 代替统一provider/protocol假设，使用已配置实际 Orca executable与公开资源回执。新证据独立目录，记录版本、原生实际模型、Task/Dispatch/Session、coverage、四角色、same-session resume、Validator续接、Recovery以及bwrap哨兵结果。不读取 Coordinator CredentialStore作为 Worker认证。不运行时skip，不据旧PASS宣布本轮成功。专用隔离项目串行运行；失败/unknown保留现场至诊断与证据落盘。用户已授权逐步回收本轮不用的终端和工作树：核验精确资源归属、保留证据后经公开 CLI 关闭/移除，当前诊断或运行现场保留。新增受支持项后再运行一个混合Harness Controller闭环。费用仅报告真实usage。

### D-06 已批准的 Controller 消息与恢复修复

用户批准修复真实 Controller 暴露的共享缺陷：Worker question 的发送地址按公开 Orca 的 Dispatch mailbox 与精确 Task/Dispatch 校验；已经退出的 Validator 步骤问题以既有 Validation Attempt 游标保留引用，不向失效 Dispatch 发出许可，也不当作已验收结果。Capsule 读取须能在旧未确认批次存在时取得同 Run、精确 Task/Dispatch 的已上报正文；只消费有界公开查询，整批确认仍由原 Delivery 流程拥有。重启续办沿原 Scope、Run、Task、OperationId 和预算，不重派已完成 Utility。

用户同时批准拉取更新 `references/orca`，从源码核对每个候选的内置 ID、真实进程识别与启动支持；固定更新 SHA，并运行 Companion adapter 回归。源码支持与已安装 Orca 的实际能力分开记录，不修改上游实现。

替代 Session 复用原 Orca Task 时显式传入原 `sourceDispatchId` 的 `retryOfDispatchId`，不改变业务 Attempt。派发回执使用既有 canonical parser；prepared terminal 接管并提交后才观察原生 Session。整批消费引用经 startup/replay 原管线传递，混合 Capsule 与普通结果仍须全部消费才确认。已接受却没有 Session 证明的旧派发保持阻塞，不换 ID 重发；该失败现场存证回收后可新建独立验收项目。

首次授权后以既有 `repointExecutionLeaseFor` 对齐当前 Runtime fencing 身份。Worker 问题经 Wake 准入确认后，模型仍可从同 Run 的有界公开历史查询读取正文并按原身份回复；最多核验 100 条，保留 Task/Dispatch/发送者与 64 KiB 正文边界。Capsule 正文落盘回读后仅由原 Delivery 重放流程确认，移除重复的直接 ack。测试重开原 Scope 显式调用 `retry-session`，保留生产 halted 规则。

真实验收进一步暴露两处信封正文遗漏：工作包 title 必须进入既有 instructions，Validator 收到 finish 后须用最后一次 verify 的完整 evidence JSON 作为 worker_done 正文；自然语言成功声明不能代替证据。沿原 IC-07/08 传递已有正文，不新增字段、不将缺证据的旧结算回填为通过。验收中断要关闭经回执核验的精确 prepared terminal：公开 worker-stop 对 external terminal 不负责关闭。

替代 Validator 的步骤绑定从精确 recovered 记录推导原 Recovery launch 报告路径，核验 Task、业务 Attempt、替代 Dispatch/Segment/Binding；授权仍来自原 Task。Delivery 重放成功时以既有 ackLaneKey 返回本轮已确认的精确 lane，仅解除匹配的临时 Delivery blocker；accepted/retired/cancelled 节点不投影为等待 frontier。重启复用已完成 Finalizer 时，必须同时匹配当前确定性 Verdict/Task/Attempt、Session Segment、原物化授权与同 Run/Dispatch 的结算；未结算旧派发仍要求只读启动证明。全部复用既有事实，无新增持久状态或 schema。

## Risks / Trade-offs

可配置端点不等于完整能力。新版本CLI和当前Orca识别表可能阻止候选；排除规则允许有依据的缩小支持名单。用户认证文件由原生CLI拥有，配置追加与真实运行证据不得含秘密。现有默认矩阵skip保留，普通测试无外部副作用。

## Migration Plan

无数据迁移。旧五家接口实现补齐新增方法；已批准Task/Profile不改，新增候选显式选择并按现有授权流程应用。同步当前合同与过时change上下文，保留历史证据。实现后独立验收，不提交、不自动archive。

## Open Questions

无产品或合同决策待定；候选CLI实际能力与Antigravity登录是有界验收前置条件，按D-01记录结果。
