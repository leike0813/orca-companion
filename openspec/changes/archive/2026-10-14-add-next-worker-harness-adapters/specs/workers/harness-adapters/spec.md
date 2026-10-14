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
