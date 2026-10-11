## MODIFIED Requirements

### Requirement: 应用层 WorkerHarness 端口与显式注册表

Companion SHALL 通过应用层 `WorkerHarness` 端口访问 Worker Harness，并由 bootstrap 显式注册通过完整验收的 adapter，保留 codex、claude、opencode、pi、omp。端口 SHALL 封闭表达新建 Session 启动、按精确身份恢复、Session 身份证明与 transcript 身份复核、只读启动、能力探测、原生模型目录查询与精确 transcript Recovery 读取配方。启动输入 MUST NOT 携带 CredentialStore、凭据路径或任何可设置/覆盖原生环境与隔离根的字段；launch 只可指定 Companion reporter/launcher 工件目录，resume MAY 额外携带已证明的 `expectedNative` 路径，仅用于核验且 MUST NOT 覆盖真实环境。每个 harness id SHALL 至多对应一个注册实现；未注册 id SHALL 在派发前以结构化原因拒绝，SHALL NOT 回退默认 harness、按文件扫描自动发现或按名称推断能力。新增 harness SHALL 只需实现端口并注册，SHALL NOT 修改 Worker 生命周期、预算或角色规则。

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

## ADDED Requirements

### Requirement: 新候选以真实能力证据纳入

新注册候选 SHALL 使用批准的真实模型、原生认证与公开接口，证明 Orca 接管真实 agent、精确 Session 与可寻址原生 transcript、原 Session 精确恢复、生产只读包装器、四角色及 Recovery 读取。中国区 MiniMax 测试 SHALL 使用 MiniMax-M3.1-Flash-Preview；Antigravity SHALL 使用用户登录后的 gemini-3.8-flash-medium。证据 SHALL 记录版本、原生模型依据、精确资源身份、测试结果与边界，且不含秘密。未通过候选 SHALL 不注册并记录缺口；不因单项失败阻止其它已通过候选。目录查询缺失 MAY 沿用未验证 exact ID 手填，SHALL NOT 捏造 effort 能力。

#### Scenario: 完整证据后纳入候选

- **WHEN** 新候选在独立测试项目中通过全部必要能力与真实角色、恢复和隔离验证
- **THEN** 正式注册该 adapter 并提供一致的模型选择和 doctor 能力结果

#### Scenario: 缺必要能力时排除

- **WHEN** 候选无法证明精确 Session、原 Session 恢复、Orca 接管或只读隔离
- **THEN** 记录证据与排除原因，不注册、不伪造身份、不放宽权限，其他候选继续验证

#### Scenario: 未运行的验收如实保留

- **WHEN** 登录、安装或真实测试尚未完成
- **THEN** 该项标记待验证，不把官方接口说明或历史 PASS 当作本轮运行证据

### Requirement: 生产只读启动保留真实前台身份与终端注入防护

生产 bwrap launcher SHALL 保留当前 Orca 可独立识别的真实 harness foreground 进程，继续强制仓库、Git/common dir 与协调库拒写，并通过 seccomp 拒绝 TIOCSTI 与 TIOCLINUX 终端注入。过滤器安装失败或 CPU ABI 不支持 SHALL 拒绝启动；SHALL NOT 依赖宿主 sysctl、伪造 process identity 或放宽文件权限。

#### Scenario: 前台身份与只读防护同时成立

- **WHEN** 通过共享 launcher 启动只读 Worker
- **THEN** Orca 可接管真实 harness，终端注入被权限错误拒绝，仓库与协调库写入被拒绝，而精确 native state 与 Companion 工件仍可写

#### Scenario: 防护无法安装时拒绝启动

- **WHEN** CPU ABI 不支持或 bwrap 无法安装终端注入过滤器
- **THEN** launcher 非零退出且不启动未受保护的 harness
