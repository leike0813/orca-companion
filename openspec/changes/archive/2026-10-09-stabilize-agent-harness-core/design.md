## Context

生产图装配漏传 configurationRef，响应提交失败后每秒对账再次处理未消费消息。固定节点重试未限制跨 invoke 请求；blocked 原因只进入诊断。基线 c988b89，直接前驱 2026-10-08-rework-coordinator-provider-configuration 已归档。本 change 解阻塞 active ledger-lab，保留其未完成业务验收。

## Goals / Non-Goals

完成可信响应提交、持久停止、可取消重试、独立调试与正式链路验收。保持现有协调语义、输入合同和已批准 Ink 原型；不迁移 UI 框架、不重新实现 provider gateway、不更改 Worker 授权。

## Decisions

### D-01 共用现有小图与轮次驱动
保留 model/tools/suspend StateGraph，configurationRef 成为必填可信依赖并在请求前校验。抽出共享轮次驱动，两个宿主调用同一驱动；轮次不是协调业务状态机。驱动在 checkpoint adapter 的独立轮次记录中请求前写 running，完成写 idle，异常或图 stalled/blocked 写 halted。本地停止 latch 先于持久写，存储异常不能导致再次请求。running 在进程恢复时视为中断，明确恢复后才能运行。结构化失败码与有限诊断可查询，不保存凭据或原始 provider 错误体。相比迁移 createAgent/DeepAgents，这保留串行工具、增量权威正文与可信 replay；其默认 middleware、消息压缩和工具并行不适合现有合同。

### D-02 唯一可重试分类
model-call 拥有共享分类：只接受结构化网络错误、429 和 500/502/503/504；最多三次，SDK 内层重试关闭。解析、类型、普通 Error、fencing、cancel、上下文、提交和输出限制不重试；等待期间响应 AbortSignal。预览故障只降级显示。工具节点传递取消信号，但 unknown mutation 仍沿原 OperationId 对账。

### D-03 宿主停止与恢复
协调宿主所有 invoke、pendingWake、定时 wake、keepalive 入口都经过轮次停止检查。stop 先 latch 和 abort，再保存；exit 意图直接 abort，再保存草稿。retry 回读原历史、配置、租约与 pending intents，未证实副作用拒绝恢复。会话摘要投影结构化轮次原因，不通过 transcript 添加虚构回复。Scope Pause/Cancel/Resume 保持原语义，Resume 不隐式解除轮次停止。

### D-04 调试身份和装配
`--debug` 是独立 launch profile，目录用 realpath 归一化；XDG state/orca-companion/debug 保存 session registry、checkpoint、ui 和 diagnostics。选择新建/继续及用户模型库中的已有模型，Session 固定配置快照，复用唯一 CredentialStore、固定 SDK adapter 与 capability probe。没有 Scope、Graph、Run、Worker 或假 ControllerSnapshot。调试消息采用显式无 Scope 来源变体，保持原协调 Wake 记录可读。

### D-05 调试只读工具
workflow 定义封闭 list_files/read_file/search/git_diff schemas，filesystem adapter 只读真实根目录，所有路径在读取前核验 realpath，拒绝越界与非普通文件。目录遍历、文件读取、搜索、Git 子进程各有处理量/输出/时间预算，工具上下文传递 signal。Git 使用 argv、禁止 external diff/textconv。返回 accepted 结果或结构化 rejected，取消不续发模型。

### D-06 对话和输入接缝
从协调 shell 抽出共用 conversation 组件/控制，复用 Transcript、Composer、transcript-reader 和 input-protection；debug shell 只提供会话/模型选择、命令和对话。UiInputTarget 新增显式 debug-message 身份，独立 key 与数据库，不改原 message/answer key。commands.ts 是 stop/retry 与 debug 可见性的唯一来源。维持正文单一 owner、grapheme cursor、粘贴唯一范围、CAS、稳定 submissionId 和未知核验。IC-04/11/12/13/14 范围和身份合同保持。

### D-07 验收与审计
复用现有 Vitest/tuistory 和本地 HTTP/SSE，真实 CLI/PTY→SDK→服务记录请求次数及历史。覆盖结构化 greeting、工具续接、断流/429、非重试异常、输出超限、Ctrl+C、重启不自动恢复、明确 retry；应用存储故障在测试装配注入，不提供生产 fault command。逐入口审计隐藏重试，生产宿主追加回归。最后在新隔离 Session 中执行有总请求上限的 MiniMax smoke，现场旧 Session 不调用。

## Risks / Trade-offs

SQLite 新轮次记录需要增量迁移；原历史/草稿不重写。老 Session 无轮次记录按首次 idle 处理，但 checkpoint 损坏仍遵守原阻塞规则。存储写失败的本地 latch 无法跨进程独立持久；因此请求前 running 记录必须先成功写入。只读工具只承诺目录边界与有界读取，不能成为任意 shell。Ink 保留已有维护成本，UI 框架迁移单开 change；pi Editor 不能完整承载持久 cursor/paste，OpenTUI 当前 Node 基线不兼容。

## Migration Plan

先建立轮次/输入扩展、再接线协调与调试、再真实链路验收。保留所有旧 keys、消息、预算和 mutation 身份，失败不清库或自动创建替代 Session。更新架构/合同/CLI与TUI交接文档；任务完成后记录实际验收，未经授权不提交或归档。

## Open Questions

无阻塞决策。框架迁移、Windows 和新的输入法人工验收由后续独立工作处理。
