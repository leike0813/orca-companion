# Design

## Context

基线为 13b203f，前驱已归档，现有七家已注册。上游 cc5c85f 有七个新候选的 TUI 配置；本机 Orca 1.4.222 的实际接管仍独立验收。现有 WorkerHarness 已拥有完整生命周期接缝，不另建状态机。用户批准独立报告插件安装与 Muse/Cursor 延后真实验收。

## Goals / Non-Goals

七家完成 adapter 并显式登记身份；五家使用现有订阅按当前 basic/enhanced/complete 规则探索真实资格。不能可靠解决的能力保留具体阻塞和后续验收前置条件，只限制需要该能力的操作。Muse/Cursor 离线完成，缺少基础真实证据时保持 unavailable。不修改 ledger-lab、上游源码、Coordinator 认证、schema 或 #52 布局。

## Decisions

### D-01：原生事实与报告交叉证明

报告只定位当前 launch 的精确 Session，不承担身份权威。Antigravity 使用 hook 的 conversationId 与 cache 精确 metadata、transcript；Kilo 使用 session plugin 与 ID export；Kimi 使用 lifecycle hook 与排除全局日志的 ZIP export；Hermes 使用 Session hook/plugin 与公开 export，不修改 max_sessions；Cline 使用公开 Session 接口与任务记录，避免失效 hooks-dir；Muse/Cursor 使用原生 hook/Session 协议与导出。全部拒绝模糊恢复、陈旧或冲突报告、无法证明的活动历史。具体版本不具备公开能力时留明确阻塞证据，不伪造实现或 PASS。

### D-02：独立报告安装，启动只检查

scripts/worker-harness-reporting.mjs 提供 install/status/uninstall --harness，优先官方安装命令，无公开命令时只维护自有 hook 条目。格式定义与报告逻辑由各 adapter 拥有，脚本仅分派；不引入通用插件平台。插件根据可信 launch descriptor 的报告路径路由，非 Companion invocation 无动作。安装与卸载保留其他原生配置，缺安装/权限/身份事实结构化拒绝，不在 Worker 启动补写配置。报告不含 secret。现有 installReporter 继续只生成 Companion 私有 launch 工件。

### D-03：复用生产与恢复接缝

WorkerHarness、Session Binding、process-runner、worker-runtime、readonly wrapper、Controller、授权/预算与 Recovery 为唯一事实源。各候选实现只处理原生协议与格式。native runtime roots 从实际 launch 环境解析，保持真实 HOME/XDG；只读仓库/Git/common dir/协调库与可写 native roots 无法分离时拒绝。registry 显式登记已实现 adapter；`worker-harness-qualifications.ts` 拥有事实摘要，`worker-harness-support.ts` 唯一推导等级，身份登记不授予角色权限。

### D-05：Antigravity 原生 TUI 输出适配

Antigravity 使用真实原生 TUI 与精确 `--conversation`。现有 launcher 的封闭私有
`outputProtocol: antigravity-tui` 只允许 Antigravity；Linux 系统 `script` 保持原生
PTY、尺寸、输入与信号，运行在同一只读边界内。launcher 内过滤三种完整、重复的
输入协议设置，其他输出重置去重；控制字符串内不解析，缓冲有界，未知及截断字节
原样转发。真实输入框、标题、hook 与 Session 仍由原生进程提供，不绘制替代 UI。
Orca 继续拥有 preamble 提交、公开就绪与监督生命周期。新模式重新通过完整矩阵。
Session 身份可以从原生 conversation_summaries.db 按完整 ID 只读核验 workspace；
这不读取 Orca DB。transcript 的配对 GENERIC/ERROR 是已终结工具事件，RUNNING
和未知状态仍拒绝完整覆盖。

Recovery 读取配方使用 Task Envelope 已提供的输出字段与可信覆盖证据，只用有界
前台 Node 读取精确 JSONL。原生 run_command 以 RunPersistent=false、
WaitMsBeforeAsync=30000 等待短读取，不通过额外目录搜索寻找协议；原生后台任务
留下的 RUNNING 启动记录仍按覆盖不可证明拒绝。

### D-04：分级验收与现场回收

Antigravity 优先，目标 gemini-3.8-flash-medium；Kilo/Kimi/Hermes/Cline 目标 MiniMax-M3.1-Flash-Preview，使用原生用户配置。真实测试串行，复用现有四角色/resume/Validator/Recovery 与 mixed Controller fixtures。Muse/Cursor 离线覆盖完整原生协议与拒绝边界，后续真实任务明确前置账号、版本、Orca 接管及只读嵌套 sandbox 验收。每轮保留 receipt 与 exact Session 证据后，公开 CLI 回收已终结的测试资源；unknown 不换 ID 重试或清理。

每个候选按等级取得真实证据：basic 使用 Planner/Implementation 的精确 Orca 绑定、成功结果与工件；enhanced 增加四角色精确 Session、Implementation resume 和 Validator 同 Session 续接；complete 增加完整历史、Recovery 与 mixed Controller。模型回显、usage、目录只作诊断，只读按任务需要单独核验。单轮超时和未尝试项不足以否定已有成功事实；不能满足的能力须记录尝试路径、原生来源和重新验收前置条件，保持对应操作拒绝。

## Risks / Trade-offs

上游配置不保证本机可接管。Antigravity transcript 缺 header，需要独立 metadata；Cline hooks-dir 不能用作成功证据；Hermes 本机 banner 与源码版本须同时记录；Cursor 的 agent/cursor-agent 命名须实际验证。身份或覆盖无法证明将阻塞对应候选。独立插件会新增自有原生配置条目，但不会管理 provider/认证/default model。

## Migration Plan

无数据迁移。候选按通过顺序注册；插件可独立卸载。恢复保持原 Task/profile/授权绑定。更新 IC-07、AGENTS、兼容性与研究文档；不改历史 PASS。

## Open Questions

无产品决策未定；剩余为可通过源码、离线和真实测试判断的能力事实。
