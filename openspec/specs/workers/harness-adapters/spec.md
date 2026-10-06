# workers/harness-adapters Specification

## Purpose

定义 Companion 的 Worker Harness 端口、显式注册表与四个新 harness 的隔离启动、精确会话身份、精确恢复、认证来源与只读执行合同，使新增或替换 harness 不改变 Worker 生命周期、预算与角色语义。

## Requirements

### Requirement: 应用层 WorkerHarness 端口与显式注册表

Companion SHALL 通过应用层 `WorkerHarness` 端口访问 Worker Harness，并由 bootstrap 以显式条目注册 codex、claude、opencode、pi、omp；端口 SHALL 封闭表达新建 Session 启动、按精确身份恢复、Session 身份证明、只读启动与能力探测五类能力。每个 harness id SHALL 至多对应一个注册实现；未注册 id SHALL 在派发前以结构化原因拒绝，SHALL NOT 回退默认 harness、按文件扫描自动发现或按名称推断能力。新增 harness SHALL 只需实现端口并注册，SHALL NOT 修改 Worker 生命周期、预算或角色规则。

#### Scenario: 已注册 harness 进入既有生命周期

- **WHEN** Manifest 绑定的角色 profile 引用一个已注册 harness
- **THEN** Controller 用该注册实现完成启动、恢复与绑定，生命周期、预算与验收语义不变

#### Scenario: 未注册 harness 在派发前拒绝

- **WHEN** 配置或 Manifest 引用未注册 harness id
- **THEN** Controller 在派发前以结构化原因拒绝，且不修改已批准绑定或产生任何外部操作

#### Scenario: 注册表唯一且显式

- **WHEN** bootstrap 装配 Worker Harness 端口
- **THEN** 每个 harness id 只对应一个显式实现，不按目录扫描或运行时自动注册

### Requirement: 隔离启动与精确 provider session 身份

每个 adapter SHALL 以该 harness 自己的隔离状态根启动 Worker，并只接受该 harness 可核验的 provider session 身份与可寻址 transcript 来源：claude 以 SessionStart hook 上报的 session id 与精确 transcript path 为准；pi 以原生 `session_start` extension 上报的 session id、transcript path 与 active branch header 为准；omp 以 extension 等待真实 session 文件出现后回读的 exact session id 与 fullpath 为准；opencode 以隔离 `--standalone` 私有子进程的公开 `GET /api/session`（`{data, cursor:{previous, next}}` 形状）为准，消息只经 v2 分页接口 `/api/session/:sessionID/message` 的 limit/cursor 读取。事实缺失、冲突、候选不唯一或观察陈旧时 SHALL 判为不可用并阻塞该 Dispatch；adapter MUST NOT 按 cwd、mtime、终端输出、最近会话或直接读取 harness 数据库推断身份。

#### Scenario: 四个 harness 各自给出精确绑定

- **WHEN** claude、pi、omp 或 opencode 的 Dispatch 报告其 hook、extension 或公开 metadata 身份
- **THEN** adapter 只在该 harness 的 id、path 与观察窗口一致且候选唯一时签发 Session Binding，否则返回不可用

#### Scenario: opencode 不以数据库或终端猜身份

- **WHEN** opencode Dispatch 需要读取输出或 transcript
- **THEN** adapter 只使用隔离 `--standalone` 子进程的公开 metadata 与分页消息接口，不直接打开其 SQLite 存储、不按屏幕输出猜 session

#### Scenario: 陈旧观察不推进绑定

- **WHEN** 某次观察早于该 Dispatch 的启动窗口，或同一 Dispatch 出现多个候选 session
- **THEN** adapter 判定绑定不可用并阻塞该 Dispatch，不用较旧或较新的候选替代

### Requirement: 精确恢复与新建 Session 的身份回读

resume SHALL 使用原 Session Binding 的精确身份：claude 原 session UUID、opencode 原 session id（同一隔离状态）、pi 原 exact session path/id、omp 原 exact fullpath/id；恢复 SHALL 沿用原 WorkerTask 的 harness 与 profile 绑定。omp 没有指定新 session id 的启动参数，新建 Session 的 exact id/fullpath SHALL 由 extension 回读并持久化后才可用于派发。SHALL NOT 使用 `--continue`、picker、前缀模糊匹配或最近会话；无法证明恢复的是原 session 时 SHALL 阻塞，MUST NOT 以新建 Session 冒充恢复。

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

managed 凭据 SHALL 只由 bootstrap 注入的 CredentialStore 解析，且 secret SHALL 只进入 harness 子进程环境；公开 terminal command、argv、CLI 参数、项目配置、诊断与记录 SHALL 只含非秘密描述符。`harness_login` SHALL 是显式 auth source，使用该 harness 隔离状态根内的登录态；adapter MUST NOT 读写或改写用户全局 harness 配置与凭据，也 MUST NOT 以全局登录态覆盖 managed key。凭据缺失、auth source 不可证明或状态根不可隔离时 SHALL 阻塞，不得自动 fallback 到其它认证或其它 harness。

#### Scenario: managed 秘密只进子进程环境

- **WHEN** Worker 以 managed 凭据启动
- **THEN** 秘密只出现在子进程环境，公开命令、配置与记录中只有 credentialRef 与不透明描述符

#### Scenario: harness_login 使用隔离登录态

- **WHEN** 角色 profile 选择 `harness_login`
- **THEN** adapter 只使用该 harness 隔离状态根内的登录态副本或链接，不读取也不修改用户全局配置与凭据

#### Scenario: 凭据不可用时阻塞

- **WHEN** 凭据缺失、权限不安全或 auth source 无法证明
- **THEN** 启动以结构化原因阻塞，不猜测其它凭据、不自动改用另一种认证

### Requirement: 只读角色共用受限包装器

Finalizer、Recovery Capsule Utility 与基线只读路径 SHALL 在 Ubuntu 上经同一个 bwrap 包装器启动，生产启动与 doctor/probe SHALL 使用同一包装器与同一 harness 启动描述符。包装器 SHALL 使仓库与 Git 事实只读，只允许该 harness 的精确状态根与临时目录写入，且 SHALL NOT 允许写 coordination.sqlite、checkpoints.sqlite、canonical 工作区或用户全局配置。包装器不可用或边界无法证明时 SHALL 以结构化 blocker 停止，不得改用更宽权限。

#### Scenario: 生产与探针共用包装器

- **WHEN** 只读角色正式启动或 doctor 探测只读能力
- **THEN** 两者使用同一 bwrap 包装器与同一 harness 启动描述符，探针结论可覆盖生产路径

#### Scenario: 状态根可写而协调库不可写

- **WHEN** 受限角色尝试写入其精确状态根或临时目录
- **THEN** 写入成功；对 coordination.sqlite、checkpoints.sqlite 与 canonical 工作区的写入被拒绝

#### Scenario: 包装器不可用时阻塞

- **WHEN** bwrap 不可用或只读边界无法核验
- **THEN** 只读角色以结构化 blocker 停止，不派发、不消耗 Recovery 预算、不使用更宽权限