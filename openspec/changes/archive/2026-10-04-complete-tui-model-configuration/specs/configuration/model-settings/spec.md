## Purpose

定义项目模型与 provider 连接的不可变配置编辑、用户级凭据存储及并发保存边界，让显式保存与显式应用分开，且真实启动取得对应凭据而不把秘密复制到项目或协调记录中。

## ADDED Requirements

### Requirement: Immutable versioned model settings
项目配置 SHALL 使用 v2 并保存 provider connections、models、Coordinator configurations 与角色 Worker Profiles。编辑 SHALL 追加不可变引用并以 revision CAS 原子保存；保存 SHALL NOT 自动改变 Session 或已批准 Manifest。旧格式、未知引用、重复身份、含秘密的选项与无可信来源的 effort SHALL 被拒绝。

#### Scenario: 保存与应用独立
- **WHEN** 用户在执行期间编辑并保存模型或连接
- **THEN** 候选配置可供后续审阅，既有 Session、Manifest、Task 和消耗预算保持不变

#### Scenario: 冲突和文件失败保留输入
- **WHEN** 文件已被其他编辑修改或写入/回读失败
- **THEN** 保存失败且保留编辑，不覆盖较新配置、不宣称生效

### Requirement: User credential store with isolated secrets
API key SHALL 保存到 XDG_CONFIG_HOME 或 ~/.config 下 orca-companion/credentials.json，目录0700、文件0600，使用短写锁、revision CAS 和原子替换。引用 SHALL opaque 且不可变。秘密 SHALL 只存在于编辑内存、CredentialStore 和必要子进程环境，SHALL NOT 出现在项目、UI input store、checkpoint、命令参数、诊断或证据。

#### Scenario: 先存凭据再存引用
- **WHEN** 用户保存带新 key 的连接
- **THEN** 凭据先保存并回读，随后才保存项目引用；后者失败不激活配置，保留输入，孤立凭据不被误报为已应用

#### Scenario: 缺失凭据和并发写入
- **WHEN** 凭据不存在、权限不正确、锁忙或 revision 已变
- **THEN** 以结构化原因拒绝，不猜测其他凭据、不泄露 key、不覆盖其他写者
