# workers/harness-adapters Specification

## Purpose

定义 Companion 的 Worker Harness 端口、显式注册表、证据推导的准入等级与新候选 harness 的隔离启动、精确会话身份、精确恢复、认证来源与只读执行合同，使新增或替换 harness 不改变 Worker 生命周期、预算与角色语义。

## Requirements

### Requirement: 应用层 WorkerHarness 端口与显式注册表

Companion SHALL 通过应用层 `WorkerHarness` 端口访问 Worker Harness，登记与准入分别表达：由 bootstrap 显式登记 adapter 身份，准入等级由证据单独推导，保留 codex、claude、opencode、pi、omp。端口 SHALL 封闭表达新建 Session 启动、按精确身份恢复、Session 身份证明与 transcript 身份复核、只读启动、能力探测、原生模型目录查询与精确 transcript Recovery 读取配方。启动和原生模型查询为公共能力；精确会话、只读、续接和恢复 SHALL 按可选能力组提供，所需能力组缺失即结构化拒绝，不自动回退。启动输入 MUST NOT 携带 CredentialStore、凭据路径或任何可设置/覆盖原生环境与隔离根的字段；launch 只可指定 Companion reporter/launcher 工件目录，resume MAY 额外携带已证明的 `expectedNative` 路径，仅用于核验且 MUST NOT 覆盖真实环境。每个 harness id SHALL 至多对应一个注册实现；未注册 id SHALL 在派发前以结构化原因拒绝，SHALL NOT 回退默认 harness、按文件扫描自动发现或按名称推断能力。新增 harness SHALL 只需实现端口并注册，SHALL NOT 修改 Worker 生命周期、预算或角色规则。

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

#### Scenario: 恢复按 adapter 的精确历史语义读取

- **WHEN** Recovery 需要复核 transcript 身份并读取原 Session 历史
- **THEN** 使用该注册项的身份复核与读取配方，无法证明时阻塞，不把其它 harness 的格式或活动分支语义套入原 transcript

#### Scenario: 已登记但未验证

- **WHEN** adapter 已登记而基础真实证据缺失
- **THEN** 可展示其身份及未验证原因，但不能派发

### Requirement: 新候选以真实能力证据纳入

候选 SHALL 使用批准的真实模型、原生认证与公开接口，并按 harness-support 的等级合同取得准入，不要求基础角色通过全部角色、完整历史和 Recovery。中国区 MiniMax 测试 SHALL 使用 MiniMax-M3.1-Flash-Preview；Antigravity SHALL 使用用户登录后的 gemini-3.8-flash-medium。证据 SHALL 保留版本、环境、原生模型依据、精确资源身份、测试结果、边界与缺口，且不包含秘密。未通过候选 SHALL 不注册并记录缺口；不因单项失败阻止其它已通过候选。目录查询缺失 MAY 沿用未验证 exact ID 手填，SHALL NOT 捏造 effort 能力。

#### Scenario: 完整证据后纳入候选

- **WHEN** 新候选在独立测试项目中通过全部必要能力与真实角色、恢复和隔离验证
- **THEN** 将已登记 adapter 的支持等级提升为 complete，并提供一致的模型选择、支持等级与 doctor 能力结果

#### Scenario: 缺必要能力时排除

- **WHEN** 候选无法证明基础级必要能力（输入、精确 Orca 归属、Planner 与 Implementation 结果及产出核验）
- **THEN** 记录证据与准入拒绝原因，不授予 basic、不派发、不伪造身份、不放宽权限；更高等级的能力缺口只限制需要这些能力的操作，其他候选继续验证

#### Scenario: 未运行的验收如实保留

- **WHEN** 登录、安装或真实测试尚未完成
- **THEN** 该项标记待验证，不把官方接口说明或历史 PASS 当作本轮运行证据

#### Scenario: 模型响应不回显 ID

- **WHEN** 启动固定获批 exact ID、基础任务通过，而 provider 不回显模型或 usage
- **THEN** 按执行证据准入并显示模型/usage 未验证，不推算费用

### Requirement: 生产只读启动保留真实前台身份与终端注入防护

生产 bwrap launcher SHALL 保留当前 Orca 可独立识别的真实 harness foreground 进程，继续强制仓库、Git/common dir 与协调库拒写，并通过 seccomp 拒绝 TIOCSTI 与 TIOCLINUX 终端注入。过滤器安装失败或 CPU ABI 不支持 SHALL 拒绝启动；SHALL NOT 依赖宿主 sysctl、伪造 process identity 或放宽文件权限。

#### Scenario: 前台身份与只读防护同时成立

- **WHEN** 通过共享 launcher 启动只读 Worker
- **THEN** Orca 可接管真实 harness，终端注入被权限错误拒绝，仓库与协调库写入被拒绝，而精确 native state 与 Companion 工件仍可写

#### Scenario: 防护无法安装时拒绝启动

- **WHEN** CPU ABI 不支持或 bwrap 无法安装终端注入过滤器
- **THEN** launcher 非零退出且不启动未受保护的 harness

### Requirement: 隔离启动与精确 provider session 身份

每个 adapter SHALL 在 harness 自身的真实用户环境中启动 Worker，继承真实 launch 的 `process.env`，非秘密 runtime roots 由真实 launch 环境解析；不再建立隔离 HOME/XDG、复制或链接认证资产，也不再生成原生 provider 配置；模型、effort 与 report/security 设置 SHALL 只经该 harness 公开的逐次调用参数或 overlay 表达。增强与完整级 SHALL 使用独立核验的精确 provider session 与 transcript，不按 cwd、mtime、最近会话或终端输出推断；基础级 MAY 只使用真实 Orca Worker 执行绑定见证。只接受该 harness 可核验的 provider session 身份与可寻址 transcript 来源：claude 以 SessionStart hook 上报的 session id 与精确 transcript path 为准；pi 以原生 `session_start` extension 上报的 session id、transcript path 与 active branch header 为准；omp 以 extension 等待真实 session 文件出现后回读的 exact session id 与 fullpath 为准；opencode 以 `--standalone` 私有子进程的公开 `GET /api/session`（`{data, cursor:{previous, next}}` 形状）为准，消息只经 v2 分页接口 `/api/session/:sessionID/message` 的 limit/cursor 读取。`worker-runtime` SHALL 从真实 launch 环境解析该进程的原生有效路径，并只把非 secret paths 经 `runtimeReportPath` 写入报告，MUST NOT 记录整个环境变量表、反向从报告生成环境或写入任何秘密。事实缺失、冲突、候选不唯一或观察陈旧时 SHALL 判为不可用并阻塞该 Dispatch；adapter MUST NOT 按 cwd、mtime、终端输出、最近会话或直接读取 harness 数据库推断身份。

#### Scenario: 四个 harness 各自给出精确绑定

- **WHEN** claude、pi、omp 或 opencode 的增强或完整级 Dispatch 报告其 hook、extension 或公开 metadata 身份
- **THEN** adapter 只在该 harness 的 id、path 与观察窗口一致且候选唯一时签发原生 Session Binding，否则返回不可用

#### Scenario: 基础级没有 SessionStart

- **WHEN** 已获准基础任务未提供原生 Session 报告
- **THEN** 按真实 Orca 执行绑定结算，不填造 Session 或 transcript

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

### Requirement: 原生模型目录的有界查询

每个注册 harness SHALL 提供原生模型目录查询：codex 用 `debug models`；claude 用 streamJSON control_request `list_models` 且不发送 prompt；opencode 用 `models`；pi 用原生公开 availability/thinking 查询；omp 用 `models --json` 的实际 thinking 取值。查询 SHALL 有界、可取消、不启动需要模型的对话、不写项目配置或用户 harness 配置，并只经既有 process-runner（可增加 bounded stdin，供控制协议使用）执行，MUST NOT 经 shell 拼接。某一 harness 查询失败 SHALL 只把该 harness 的候选标为不可用并允许手填 exact ID，MUST NOT 影响其它 harness 或捏造 effort 取值。

#### Scenario: 逐 harness 目录查询

- **WHEN** 用户显式查询某角色的候选模型
- **THEN** adapter 只以该 harness 的公开命令/协议取得候选与实际 thinking 取值，并给出查询来源标识

#### Scenario: 查询失败不阻塞手填

- **WHEN** 某 harness 的目录查询失败、超时或输出无法核验
- **THEN** 该 harness 候选标记不可用，允许手填 native exact ID 的未验证选择，且不产生 effort 取值

### Requirement: 独立安装的原生 Session 报告插件

Companion SHALL 提供独立的原生报告插件安装、状态检查与卸载步骤，仅维护自有配置条目，保留用户其他 hooks、默认模型、provider 与认证。Worker 启动 SHALL 只检查和使用已安装插件，不安装插件或改写原生配置。插件 SHALL 仅在可信 Companion launch 上下文中报告非秘密 Session、cwd、transcript 与 runtime roots；报告仍须经原生事实独立核验。

#### Scenario: 保留用户原生配置

- **WHEN** 用户安装、重复安装或卸载 Companion 报告插件
- **THEN** 其他配置与认证保持原有语义，自有条目不重复，卸载不删除其他插件

#### Scenario: 普通原生启动无动作

- **WHEN** 原生 harness 在没有 Companion launch 上下文的环境中启动
- **THEN** Companion 报告插件不写报告、不改变会话或模型

#### Scenario: 报告安装缺失

- **WHEN** 候选依赖的报告插件未安装或配置无法核验
- **THEN** probe 返回结构化 unavailable，Worker 不自动修复用户配置

### Requirement: 下一批候选保持精确原生 Session 契约

七家 adapters SHALL 在公开 Orca 终端内启动真实原生 TUI，按 `workers/harness-support` 的唯一等级规则准入。增强与完整级的 hook、plugin 或 Session API 报告 SHALL 与精确 native metadata/transcript 独立交叉核验；所需身份或覆盖不可证明时 SHALL 阻塞对应操作，MUST NOT 从最近会话、终端文本或私有数据库猜测。需要只读的任务 SHALL 复用生产包装器，保留真实 Orca foreground 身份；只读能力不参与通用等级推导。

#### Scenario: 基础角色使用 Orca 执行绑定

- **WHEN** Task 输入、精确 Orca Task/Dispatch/terminal 归属及 Planner/Implementation 的成功结果与工件均可核验
- **THEN** 可取得 basic，原生 Session、transcript 和模型回显可明确缺失

#### Scenario: 部分历史不阻挡增强级

- **WHEN** basic 已成立，另有四角色精确 Session、Implementation resume 和 Validator 同 Session 上下文续接证据，但历史覆盖仍为 partial
- **THEN** 可取得 enhanced，complete 所需的完整历史、Recovery 与 mixed Controller 仍分别保持未证明或失败状态

#### Scenario: 原生 TUI 的重复协议输出

- **WHEN** Antigravity 原生 TUI 重申已生效的输入协议设置
- **THEN** 同一 launcher 仅过滤完整识别且重复的协议设置，保留真实输入框、其他字节和全部 stdin；解析有界、控制字符串内的内容不被过滤，其他输出使后续设置重新转发。Orca 继续拥有 preamble 提交、公开就绪和监督生命周期，不伪造标题、状态或 Session

#### Scenario: 按精确身份恢复

- **WHEN** 任一新候选恢复已绑定 Session
- **THEN** 使用原 Session 的完整 ID 或原生精确路径并重新核验同一身份，不新建 Session 冒充恢复

#### Scenario: 身份或覆盖不可证明

- **WHEN** report 与 native facts 冲突、transcript 缺失或活动历史不完整
- **THEN** 绑定或 Recovery 返回 unavailable，不推进任务

### Requirement: 实现、身份登记与支持等级分别验收

新候选 SHALL 区分实现完成、离线验证、身份登记与证据推导的支持等级。Antigravity SHALL 使用已登录订阅探索验收，Kilo/Kimi/Hermes/Cline SHALL 使用可用的中国 MiniMax M Plan 探索真实验收。候选 SHALL 按 basic、enhanced、complete 逐级取得证据；模型回显、usage 与目录只作诊断，不作为准入门禁。候选的原生能力缺口经可复核调查仍无法可靠解决时，SHALL 保存已尝试路径、阻塞合同、原生证据和重新验收前置条件，只限制需要该能力的操作，MUST NOT 阻塞其他可接入候选。Muse/Cursor SHALL 保留实现、离线验证和显式身份登记，真实基础证据不足时等级 SHALL 为 unavailable；CLI、原生登录和获批模型前置条件明确后再运行真实矩阵。延期、失败与未运行项不计为 PASS。

#### Scenario: 离线完成仍不可派发

- **WHEN** Muse 或 Cursor 仅通过离线验证
- **THEN** adapter 可显式登记身份，但支持等级为 unavailable，角色派发以等级不足拒绝，并显示后续验收前置条件

#### Scenario: 真实验收支持对应等级

- **WHEN** 某候选取得某一级别全部必要的真实证据
- **THEN** 由唯一等级规则推导其支持等级、开放对应角色，并记录实际版本、可追溯证据和仍未证明的能力

#### Scenario: 阻塞候选独立延期

- **WHEN** 某候选的原生能力缺口经可复核调查仍不能满足完整验收合同
- **THEN** 记录具体阻塞和重新验收前置条件，保留未通过状态及现场，继续其他候选的验收和注册
