# configuration/model-settings Specification

## Purpose

定义项目模型与 provider 连接的不可变配置编辑、用户级凭据存储及并发保存边界，让显式保存与显式应用分开，且真实启动取得对应凭据而不把秘密复制到项目或协调记录中。

## Requirements

### Requirement: Immutable versioned model settings

项目配置 SHALL 使用 schema 4 并保存 Coordinator 的 provider connections、models、Coordinator configurations 与按角色绑定的 Worker Profiles；每个 Worker Profile SHALL 绑定一个已注册 harness 与不可变 `modelSelection`。`ProviderConnection` SHALL 只删除 Worker-only 的 `codex` 与 `nativeWorker` 字段；`credential`（含 `managed` 与沿旧命名的 `harness_login` 环境认证）、`providerIntegration` 与 `modelOptions` SHALL 保持既有 Coordinator 合同不变。编辑 SHALL 追加不可变引用并以 revision CAS 原子保存；保存 SHALL NOT 自动改变 Session 或已批准 Manifest。旧 schema（1/2/3）、未知引用、重复身份、含秘密的选项、无可信来源的 effort 与非 Coordinator 连接字段 SHALL 被明确拒绝，MUST NOT 自动迁移或改写用户文件。

#### Scenario: 保存与应用独立

- **WHEN** 用户在执行期间编辑并保存模型或连接
- **THEN** 候选配置可供后续审阅，既有 Session、Manifest、Task 和消耗预算保持不变

#### Scenario: 冲突和文件失败保留输入

- **WHEN** 文件已被其他编辑修改或写入/回读失败
- **THEN** 保存失败且保留编辑，不覆盖较新配置、不宣称生效

#### Scenario: 旧记录与旧指纹兼容

- **WHEN** 读取本 change 之前保存的 Coordinator 连接记录（不含 Worker-only 字段）
- **THEN** 连接按原 Coordinator 合同解析，字段省略与指纹保持原表示，不强制改写用户文件

#### Scenario: 非法 nativeWorker 组合被拒绝

- **WHEN** 配置中出现 `nativeWorker` 字段或其任何键
- **THEN** 读取或保存以结构化原因拒绝，且不写入任何连接记录

#### Scenario: 旧 schema 明确拒绝

- **WHEN** 读取一份 schema 1、2 或 3 的项目配置
- **THEN** 以结构化原因拒绝，不改写用户文件、不回退默认值、不静默迁移

#### Scenario: Worker-only 连接字段不再被接受

- **WHEN** 配置中出现 Worker-only 的 `codex` 字段
- **THEN** 读取或保存以结构化原因拒绝，且不写入任何连接记录；Coordinator 的 `credential` 合同不变

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
