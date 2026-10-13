## ADDED Requirements

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

Antigravity、Kilo、Kimi、Hermes、Cline、Meta Muse 与 Cursor adapters SHALL 实现真实 TUI 启动、精确身份绑定、按原 Session 恢复、有界模型目录、transcript 覆盖检查与 Recovery 读取配方。公开 hook、plugin 或 Session API 报告 SHALL 与精确 native metadata/transcript 独立交叉核验；无法证明身份、工作区或活动历史覆盖时 SHALL 阻塞，MUST NOT 从最近会话、终端文本或私有数据库猜测。只读路径 SHALL 复用已验证的生产包装器，同时保留真实 Orca foreground 身份。

#### Scenario: 按精确身份恢复

- **WHEN** 任一新候选恢复已绑定 Session
- **THEN** 使用原 Session 的完整 ID 或原生精确路径并重新核验同一身份，不新建 Session 冒充恢复

#### Scenario: 身份或覆盖不可证明

- **WHEN** report 与 native facts 冲突、transcript 缺失或活动历史不完整
- **THEN** 绑定或 Recovery 返回 unavailable，不推进任务

### Requirement: 实现状态与生产注册分别验收

新候选 SHALL 区分实现完成、离线验证、真实验收与生产注册。Antigravity SHALL 使用已登录订阅探索验收，Kilo/Kimi/Hermes/Cline SHALL 使用可用的中国 MiniMax M Plan 探索真实验收。候选的原生能力缺口经可复核调查仍无法可靠解决时，SHALL 保存已尝试路径、阻塞合同、原生证据和重新验收前置条件并单独延期，MUST NOT 阻塞其他可接入候选。Muse/Cursor 本轮 SHALL 完成实现与离线验证并记录后续真实验收任务；真实验收前 MUST NOT 注册、进入生产角色列表或允许派发。真实验收 SHALL 包含四角色、精确 resume、Validator 同 Session 续接、Recovery、只读防护与混合 Controller 闭环；延期、失败与未运行项不计为 PASS。

#### Scenario: 离线完成仍不生产注册

- **WHEN** Muse 或 Cursor 仅通过离线验证
- **THEN** adapter 可供显式测试注入，生产选择与派发仍以未注册拒绝，并显示后续验收前置条件

#### Scenario: 真实验收通过才纳入

- **WHEN** 某候选的完整真实验收通过
- **THEN** 才加入生产注册表及角色选择，并记录实际版本与可追溯证据

#### Scenario: 阻塞候选独立延期

- **WHEN** 某候选的原生能力缺口经可复核调查仍不能满足完整验收合同
- **THEN** 记录具体阻塞和重新验收前置条件，保留未通过状态及现场，继续其他候选的验收和注册
