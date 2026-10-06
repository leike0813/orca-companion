# configuration/model-settings Specification

## Purpose

定义项目模型与 provider 连接的不可变配置编辑、用户级凭据存储及并发保存边界，让显式保存与显式应用分开，且真实启动取得对应凭据而不把秘密复制到项目或协调记录中。

## Requirements

### Requirement: Immutable versioned model settings

项目配置 SHALL 使用 schema 3 并保存 provider connections、models、Coordinator configurations 与角色 Worker Profiles；每个 Worker Profile SHALL 绑定一个 harness 与不可变 modelConfiguration。编辑 SHALL 追加不可变引用并以 revision CAS 原子保存；保存 SHALL NOT 自动改变 Session 或已批准 Manifest。旧格式（schema 1/2）、未知引用、重复身份、含秘密的选项、无可信来源的 effort 与不合法的 nativeWorker 连接 SHALL 被拒绝。

`ProviderConnection.nativeWorker` SHALL 为可选、按 harness 判别的封闭联合：`providerId` 必填，`baseUrl` 可选，`api` 可选且取值限于 `anthropic-messages`、`openai-completions`、`openai-responses`；字段一律非秘密，不得出现未知键。既有 `codex` 字段 SHALL 保持不变；未含 `nativeWorker` 的记录 SHALL 按原样读取并保持原指纹省略形态，不强制改写。

#### Scenario: 保存与应用独立

- **WHEN** 用户在执行期间编辑并保存模型或连接
- **THEN** 候选配置可供后续审阅，既有 Session、Manifest、Task 和消耗预算保持不变

#### Scenario: 冲突和文件失败保留输入

- **WHEN** 文件已被其他编辑修改或写入/回读失败
- **THEN** 保存失败且保留编辑，不覆盖较新配置、不宣称生效

#### Scenario: 旧记录与旧指纹兼容

- **WHEN** 读取一份未包含 nativeWorker 的 schema 3 配置或既有 Manifest
- **THEN** 连接仍按原 codex 字段解析，序列化保持字段省略，指纹与旧记录一致，不强制升级或改写用户文件

#### Scenario: 非法 nativeWorker 组合被拒绝

- **WHEN** nativeWorker 缺少 providerId、api 取值超出封闭枚举、混入未知键或承载疑似 secret
- **THEN** 保存以结构化原因被拒绝，且不写入任何连接记录

### Requirement: Per-role harness selection with execution default

模型设置 SHALL 允许为每个 Worker 角色显式选择 harness；省略该输入时 SHALL 保留该角色既有 profile 的 harness，没有既有 profile 的角色 SHALL 取 `execution.harness` 作为首次默认。角色 harness 变更 SHALL 只作为配置编辑保存，SHALL NOT 自动改变 Session、Manifest 或在途 Task；执行期变更 SHALL 经完整 Manifest 重新批准。

#### Scenario: 显式选择角色 harness

- **WHEN** 用户为某角色显式选择已注册 harness 并保存
- **THEN** 新 profile 引用该 harness，其他角色的现有引用与其 Manifest 绑定不受影响

#### Scenario: 省略时保留或取默认

- **WHEN** 保存角色设置时未提供 harness
- **THEN** 既有 profile 保留原 harness；无既有 profile 的角色使用 `execution.harness`，未注册值被拒绝

#### Scenario: 角色 harness 不自动生效

- **WHEN** 保存了角色 harness 变更而用户未重新批准 Manifest
- **THEN** 执行期 Session、已批准 Manifest 与在途 Task 保持原 harness 绑定不变

### Requirement: User credential store with isolated secrets

API key SHALL 保存到 XDG_CONFIG_HOME 或 ~/.config 下 orca-companion/credentials.json，目录0700、文件0600，使用短写锁、revision CAS 和原子替换。引用 SHALL opaque 且不可变。秘密 SHALL 只存在于编辑内存、CredentialStore 和必要子进程环境，SHALL NOT 出现在项目、UI input store、checkpoint、命令参数、诊断或证据。

#### Scenario: 先存凭据再存引用

- **WHEN** 用户保存带新 key 的连接
- **THEN** 凭据先保存并回读，随后才保存项目引用；后者失败不激活配置，保留输入，孤立凭据不被误报为已应用

#### Scenario: 缺失凭据和并发写入

- **WHEN** 凭据不存在、权限不正确、锁忙或 revision 已变
- **THEN** 以结构化原因拒绝，不猜测其他凭据、不泄露 key、不覆盖其他写者