# configuration/model-settings Specification

## Purpose

定义项目模型与 provider 连接的不可变配置编辑、用户级凭据存储及并发保存边界，让显式保存与显式应用分开，且真实启动取得对应凭据而不把秘密复制到项目或协调记录中。

## Requirements

### Requirement: Immutable versioned model settings

项目配置 SHALL 使用 schema 5 并保存 Coordinator 的 provider connections、models、完整 Coordinator configurations 与按角色绑定的 Worker Profiles。用户级连接和模型库 SHALL 支持跨项目复用及一个连接对应多个模型。编辑 SHALL 追加不可变引用并以 revision CAS 原子保存；项目及 Session SHALL 使用明确选择的完整快照，保存和目录刷新 MUST NOT 自动改变 Session 或已批准 Manifest。Coordinator 连接 SHALL 仅使用 API Key，预设/协议、地址及不透明 credentialRef，MUST NOT 接受任意 SDK options、模块导出或认证注入路径。Worker Profile SHALL 继续绑定已注册 harness 与不可变 modelSelection。旧 schema、未知引用、重复身份、秘密字段与无可信 effort SHALL 明确拒绝，不迁移、不改写用户文件。

#### Scenario: 跨项目复用与多模型

- **WHEN** 用户为同一个连接保存多个模型并在两个项目选择它们
- **THEN** 连接和凭据可复用，每个项目保存自身明确选择的完整不可变快照

#### Scenario: 保存与应用独立

- **WHEN** 用户编辑连接、Key 或模型并保存
- **THEN** 既有 Session、Manifest、Task 和消耗预算不变，显式应用才核验并更新绑定

#### Scenario: 冲突和文件失败保留输入

- **WHEN** 文件已被其他编辑修改或写入/回读失败
- **THEN** 保存失败且保留编辑，不覆盖较新配置、不宣称生效

#### Scenario: 旧 schema 明确拒绝

- **WHEN** 读取 schema 1、2、3 或 4 的项目配置
- **THEN** 结构化拒绝并保留文件，不自动回退或迁移

#### Scenario: 复杂或秘密字段被拒绝

- **WHEN** 输入模块导出、任意 options、认证模式、注入路径或 Worker-only 连接字段
- **THEN** 配置拒绝且不写入候选连接或秘密

#### Scenario: 旧记录与旧指纹兼容

- **WHEN** 读取 schema 5 内保存的旧不可变 Coordinator 快照
- **THEN** 仍按原引用使用完整快照，编辑不改写其指纹；schema 4 和更早格式按旧 schema 拒绝规则处理

#### Scenario: 非法 nativeWorker 组合被拒绝

- **WHEN** 配置中出现 nativeWorker 字段或其任何键
- **THEN** 结构化拒绝且不写入连接记录

#### Scenario: Worker-only 连接字段不再被接受

- **WHEN** 配置中出现 Worker-only codex 字段
- **THEN** 结构化拒绝且不写入连接记录，Coordinator 使用 API Key 合同

### Requirement: Saved discovered and verified states are distinct

网络离线或核验失败 SHALL 允许保存合法连接及模型；保存、目录取得与模型核验 SHALL 分别呈现。实际启动或显式应用 MUST 通过必需能力核验。失败 SHALL 保留原绑定与编辑并提供重试或修改入口，MUST NOT 自动换模型。

#### Scenario: 离线保存与拒绝应用

- **WHEN** 配置可保存但端点不可达
- **THEN** 保存成功、模型未验证；应用拒绝且原 Session 绑定不变

### Requirement: Per-role harness selection with execution default

模型设置 SHALL 允许为每个 Worker 角色显式选择 harness；省略该输入时 SHALL 保留该角色既有 profile 的 harness，没有既有 profile 的角色 SHALL 取 `execution.harness` 作为首次默认。Worker 角色的 harness 与模型 SHALL 一并保存为新的不可变 `modelSelection`，MUST NOT 携带 provider 连接、模型选项或凭据引用。角色 harness 变更 SHALL 只作为配置编辑保存，SHALL NOT 自动改变 Session、Manifest 或在途 Task；执行期变更 SHALL 经完整 Manifest 重新批准。

#### Scenario: 显式选择角色 harness

- **WHEN** 用户为某角色显式选择已注册 harness 并保存
- **THEN** 新 profile 引用该 harness，其他角色的现有引用与其 Manifest 绑定不受影响

#### Scenario: 省略时保留或取默认

- **WHEN** 保存角色设置时未提供 harness
- **THEN** 既有 profile 保留原 harness；无既有 profile 的角色使用 `execution.harness`，未注册值被拒绝

#### Scenario: 角色 harness 不自动生效

- **WHEN** 保存了角色 harness 或模型变更而用户未重新批准 Manifest
- **THEN** 执行期 Session、已批准 Manifest 与在途 Task 保持原 harness 与模型绑定不变

### Requirement: Worker model selection and trusted catalog provenance

Worker Profile SHALL 以 `WorkerModelSelection` 表达模型：`{model, effort, effortCapability, catalogSource}`，其中 `effortCapability` 为 `{values, source}` 或 `null`，`catalogSource` 为原生目录查询来源标识或 `null`。schema SHALL 拒绝 `effortCapability` 非空而 `catalogSource` 为 `null` 的记录；非 `null` 的 effort SHALL 要求 `effortCapability` 非空且取值属于 `values`。`catalogSource` 为 `null` SHALL 表示用户手填的未验证 native exact ID，此时 effort MUST 为 `null`。保存 SHALL 经显式原生目录查询的服务缓存核验选择来源，MUST NOT 接受调用方自报的 catalogSource 或 effort；查询失败 SHALL 允许手填 exact ID，MUST NOT 捏造 effort 取值。

#### Scenario: 目录查询来源可用于 effort

- **WHEN** 用户从某次显式原生目录查询的结果中选择模型与 effort
- **THEN** 保存的 selection 携带该次查询的 catalogSource，effort 只取该模型实际报告的 values

#### Scenario: 手填未验证模型

- **WHEN** 原生目录查询失败或用户手填 native exact ID
- **THEN** 保存 `catalogSource` 为 `null` 且 effort 为 `null` 的未验证 selection，不捏造 effort

#### Scenario: 伪造来源被拒绝

- **WHEN** 保存输入的 catalogSource 或 effort 不在该次显式查询的服务缓存中
- **THEN** 以结构化原因拒绝且不写入 profile

### Requirement: User credential store with isolated secrets

API key SHALL 保存到 XDG_CONFIG_HOME 或 ~/.config 下 orca-companion/credentials.json，目录0700、文件0600，使用短写锁、revision CAS 和原子替换。引用 SHALL opaque 且不可变。秘密 SHALL 只存在于编辑内存、CredentialStore 和必要子进程环境，SHALL NOT 出现在项目、UI input store、checkpoint、命令参数、诊断或证据。

#### Scenario: 先存凭据再存引用

- **WHEN** 用户保存带新 key 的连接
- **THEN** 凭据先保存并回读，随后才保存项目引用；后者失败不激活配置，保留输入，孤立凭据不被误报为已应用

#### Scenario: 缺失凭据和并发写入

- **WHEN** 凭据不存在、权限不正确、锁忙或 revision 已变
- **THEN** 以结构化原因拒绝，不猜测其他凭据、不泄露 key、不覆盖其他写者
