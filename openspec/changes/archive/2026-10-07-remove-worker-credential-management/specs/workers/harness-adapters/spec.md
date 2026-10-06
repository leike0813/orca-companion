## MODIFIED Requirements

### Requirement: 应用层 WorkerHarness 端口与显式注册表

Companion SHALL 通过应用层 `WorkerHarness` 端口访问 Worker Harness，并由 bootstrap 以显式条目注册 codex、claude、opencode、pi、omp；端口 SHALL 封闭表达新建 Session 启动、按精确身份恢复、Session 身份证明、只读启动、能力探测与原生模型目录查询六类能力。启动输入 MUST NOT 携带 CredentialStore、凭据路径或任何可设置/覆盖原生环境与隔离根的字段；launch 只可指定 Companion reporter/launcher 工件目录，resume MAY 额外携带已证明的 `expectedNative` 路径，仅用于核验且 MUST NOT 覆盖真实环境。每个 harness id SHALL 至多对应一个注册实现；未注册 id SHALL 在派发前以结构化原因拒绝，SHALL NOT 回退默认 harness、按文件扫描自动发现或按名称推断能力。新增 harness SHALL 只需实现端口并注册，SHALL NOT 修改 Worker 生命周期、预算或角色规则。

#### Scenario: 已注册 harness 进入既有生命周期

- **WHEN** Manifest 绑定的角色 profile 引用一个已注册 harness
- **THEN** Controller 用该注册实现完成启动、恢复与绑定，生命周期、预算与验收语义不变

#### Scenario: 未注册 harness 在派发前拒绝

- **WHEN** 配置或 Manifest 引用未注册 harness id
- **THEN** Controller 在派发前以结构化原因拒绝，且不修改已批准绑定或产生任何外部操作

#### Scenario: 注册表唯一且显式

- **WHEN** bootstrap 装配 Worker Harness 端口
- **THEN** 每个 harness id 只对应一个显式实现，不按目录扫描或运行时自动注册

#### Scenario: 启动输入不含凭据与原生隔离

- **WHEN** 任一注册项准备启动或恢复
- **THEN** 启动输入不含凭据或可覆盖原生环境的隔离 root；resume 携带的 `expectedNative` 只作核验，真实 launch 环境不被改写

### Requirement: 隔离启动与精确 provider session 身份

每个 adapter SHALL 在 harness 自身的真实用户环境中启动 Worker，继承真实 launch 的 `process.env`，不再建立隔离 HOME/XDG、复制或链接认证资产，也不再生成原生 provider 配置；模型、effort 与 report/security 设置 SHALL 只经该 harness 公开的逐次调用参数或 overlay 表达。只接受该 harness 可核验的 provider session 身份与可寻址 transcript 来源：claude 以 SessionStart hook 上报的 session id 与精确 transcript path 为准；pi 以原生 `session_start` extension 上报的 session id、transcript path 与 active branch header 为准；omp 以 extension 等待真实 session 文件出现后回读的 exact session id 与 fullpath 为准；opencode 以 `--standalone` 私有子进程的公开 `GET /api/session`（`{data, cursor:{previous, next}}` 形状）为准，消息只经 v2 分页接口 `/api/session/:sessionID/message` 的 limit/cursor 读取。`worker-runtime` SHALL 从真实 launch 环境解析该进程的原生有效路径，并只把非 secret paths 经 `runtimeReportPath` 写入报告，MUST NOT 记录整个环境变量表、反向从报告生成环境或写入任何秘密。事实缺失、冲突、候选不唯一或观察陈旧时 SHALL 判为不可用并阻塞该 Dispatch；adapter MUST NOT 按 cwd、mtime、终端输出、最近会话或直接读取 harness 数据库推断身份。

#### Scenario: 四个 harness 各自给出精确绑定

- **WHEN** claude、pi、omp 或 opencode 的 Dispatch 报告其 hook、extension 或公开 metadata 身份
- **THEN** adapter 只在该 harness 的 id、path 与观察窗口一致且候选唯一时签发 Session Binding，否则返回不可用

#### Scenario: opencode 不以数据库或终端猜身份

- **WHEN** opencode Dispatch 需要读取输出或 transcript
- **THEN** adapter 只使用 `--standalone` 子进程的公开 metadata 与分页消息接口，不直接打开其 SQLite 存储、不按屏幕输出猜 session

#### Scenario: 陈旧观察不推进绑定

- **WHEN** 某次观察早于该 Dispatch 的启动窗口，或同一 Dispatch 出现多个候选 session
- **THEN** adapter 判定绑定不可用并阻塞该 Dispatch，不用较旧或较新的候选替代

#### Scenario: runtime roots 只含非秘密路径

- **WHEN** 启动报告登记进程实际使用的原生根目录
- **THEN** 报告只含路径与标识等非秘密字段，可被恢复与只读包装器复用，不落整份环境变量

### Requirement: 精确恢复与新建 Session 的身份回读

resume SHALL 使用原 Session Binding 的精确身份与原启动报告：claude 原 session UUID、opencode 原 session id、pi 原 exact session path/id、omp 原 exact fullpath/id；恢复 SHALL 沿用原 WorkerTask 的 harness 与 profile 绑定，并按原报告的 runtime roots 定位真实原生资产。resume 携带的 `expectedNative` 只用于核验，MUST NOT 覆盖或改写 harness 的真实环境。omp 没有指定新 session id 的启动参数，新建 Session 的 exact id/fullpath SHALL 由 extension 回读并持久化后才可用于派发。SHALL NOT 使用 `--continue`、picker、前缀模糊匹配或最近会话；无法证明恢复的是原 session 时 SHALL 阻塞，MUST NOT 以新建 Session 冒充恢复。

#### Scenario: 按原身份恢复

- **WHEN** 原 Session 被判定可恢复且 adapter 持有其精确身份
- **THEN** adapter 以该 harness 的精确 resume 参数恢复原 session，并用新 Dispatch 的 Session Binding 重新证明身份

#### Scenario: omp 新建会话的身份回读

- **WHEN** omp 新建 Session 后需要固定其身份
- **THEN** adapter 等待真实 session 文件出现并回读 exact id 与 fullpath，再写入绑定；回读失败即阻塞

#### Scenario: 拒绝模糊恢复

- **WHEN** 只有最近会话、前缀或 picker 可用，而没有原 session 的精确身份
- **THEN** adapter 阻塞恢复，不启动替代 Session 也不换取新身份

### Requirement: 认证来源隔离与秘密边界

Worker 启动 MUST NOT 注入 Companion 凭据、复制或链接认证资产，也 MUST NOT 建立隔离登录态；Worker 认证完全由该 harness 在真实用户环境中提供。Coordinator 的 `harness_login`（provider integration 自身环境认证，沿用旧命名）与 managed credentialRef 合同保持不变：managed 凭据只由 bootstrap 注入的 CredentialStore 解析，secret 只进入 Coordinator 模型调用路径。公开 terminal command、argv、CLI 参数、项目配置、诊断与记录 SHALL 只含非秘密描述符；删除 Worker 凭据路径后遗留的孤儿凭据 SHALL NOT 被删除或迁移。Worker 原生认证或初始环境不可证明时 SHALL 阻塞，不得自动 fallback 到其它认证或其它 harness。

#### Scenario: managed 秘密只进子进程环境

- **WHEN** Coordinator 模型调用解析 managed 凭据
- **THEN** 秘密只进入该模型调用路径，公开命令、配置与记录中只有 credentialRef 与不透明描述符；Worker 启动不接收该秘密

#### Scenario: harness_login 使用隔离登录态

- **WHEN** 连接声明 `harness_login`
- **THEN** 沿用旧命名表示 provider integration 自身环境认证，不建立隔离登录态、不复制或链接认证资产

#### Scenario: 凭据不可用时阻塞

- **WHEN** Worker 依赖的原生认证或初始环境无法证明
- **THEN** 启动以结构化原因阻塞，不猜测其它凭据、不自动改用另一种认证

### Requirement: 只读角色共用受限包装器

Finalizer、Recovery Capsule Utility 与基线只读路径 SHALL 在 Ubuntu 上经同一个 bwrap 包装器启动，生产启动与 doctor/probe SHALL 使用同一包装器与同一 harness 启动描述符。包装器 SHALL 使仓库、Git 事实、Git common dir 与协调库只读，并 SHALL 允许该 harness 真实原生运行所需的 state 目录与 Companion 工件目录写入；仓库、Git 与协调库的写入 SHALL 被拒绝。overlap 无法证明、native 所需可写路径与拒写路径无法分离时，能力 SHALL 判为 unavailable，SHALL NOT 改用更宽权限。

#### Scenario: 生产与探针共用包装器

- **WHEN** 只读角色正式启动或 doctor 探测只读能力
- **THEN** 两者使用同一 bwrap 包装器与同一 harness 启动描述符，探针结论可覆盖生产路径

#### Scenario: 状态根可写而协调库不可写

- **WHEN** 受限角色写入其真实原生 state 目录或 Companion 工件目录
- **THEN** 写入成功；对仓库、Git、coordination.sqlite 与 checkpoints.sqlite 的写入被拒绝

#### Scenario: 包装器不可用时阻塞

- **WHEN** bwrap 不可用，或 native 所需可写根与拒写根重叠且无法分离证明
- **THEN** 只读角色以结构化 blocker 停止，不派发、不消耗 Recovery 预算、不使用更宽权限

#### Scenario: 边界无法证明时不可用

- **WHEN** 只读边界无法被实际执行核验
- **THEN** 能力判为 unavailable 并保留可诊断原因，不推断可用也不放宽权限

## ADDED Requirements

### Requirement: 原生模型目录的有界查询

每个注册 harness SHALL 提供原生模型目录查询：codex 用 `debug models`；claude 用 streamJSON control_request `list_models` 且不发送 prompt；opencode 用 `models`；pi 用原生公开 availability/thinking 查询；omp 用 `models --json` 的实际 thinking 取值。查询 SHALL 有界、可取消、不启动需要模型的对话、不写项目配置或用户 harness 配置，并只经既有 process-runner（可增加 bounded stdin，供控制协议使用）执行，MUST NOT 经 shell 拼接。某一 harness 查询失败 SHALL 只把该 harness 的候选标为不可用并允许手填 exact ID，MUST NOT 影响其它 harness 或捏造 effort 取值。

#### Scenario: 逐 harness 目录查询

- **WHEN** 用户显式查询某角色的候选模型
- **THEN** adapter 只以该 harness 的公开命令/协议取得候选与实际 thinking 取值，并给出查询来源标识

#### Scenario: 查询失败不阻塞手填

- **WHEN** 某 harness 的目录查询失败、超时或输出无法核验
- **THEN** 该 harness 候选标记不可用，允许手填 native exact ID 的未验证选择，且不产生 effort 取值
