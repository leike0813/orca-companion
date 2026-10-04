## Context

规划 HEAD 为 `8f6d1a7e6765a024191043b97fbded2d4a902207`。前驱 6A 已归档。当前 project schema1、Manifest1、coordination schema15；Coordinator 支持 suspended 切换，Worker 使用全局 workerModel，prepared terminal 启动没有 effort。IC-11/12 的命令引用和返回绑定及 IC-13 的输入持久化是冻结接缝。

## Goals / Non-Goals

目标是让 #52 的模型配置成为可编辑、可保存、可授权且启动可核验的生产功能，保护在途 Task 与消耗预算。采用既有 pnpm/TypeScript/Ink/Vitest 和 Node 文件 API。

不实现新 Worker 生命周期、provider 安装、自动 fallback、偏好持久化、headless、提交或归档。Planning Utility 与 Spec Validator 显式不可用。

## Decisions

### D01 — 配置与模块 owner

`src/domain/model-configuration.ts` 定义框架无关的 `ProviderConnection`、`ModelDefinition`、`WorkerModelConfiguration` 与 `WorkerProfileConfiguration`。ProviderConnection 包含 connectionRef、label、providerIntegration、非秘密 modelOptions、credential（`harness_login` 或 `managed` 的 credentialRef 与 LangChain optionPath）、Codex connection（providerId/baseUrl/wireApi 或 null）。ModelDefinition 包含 modelRef、connectionRef、model、effortCapability（values/source/optionPath 或 null）。effortCapability 来源必须非空，非 null effort 必须属于 values；optionPath 显式描述 provider 字段，不猜 SDK。WorkerProfileConfiguration 包含不可变 profileRef、生产 profile role（四主角色或 recovery_utility）、harness、完整 modelConfiguration；Manifest 嵌入 connection/model/options/credential 引用快照。Utility 配置角色不改变领域四主角色 WorkerRole。

项目 schema2 增加 revision、providerConnections、models 和 execution.workerProfiles，删除 workerModel。Coordinator 原 DTO 保留 providerIntegration/model/modelOptions/credentialRefs/nativeWindowOwnerRef，并增加可选 providerConnection/modelRef/effortCapability/effort；旧 DTO 调用方可表达无能力数据，不能表达虚构能力。v2 允许无 Worker 配置用于纯规划，执行授权要求完整生产角色。引用唯一性与交叉引用由 project parser 统一核验。保存追加 UUID 引用，旧配置不改写；角色当前选择引用新 profile。配置适配器归 storage，bootstrap 复用 schema，不增加第二份 parser。

### D02 — CredentialStore 与文件保存

application port `CredentialStore` 提供 `metadata()` -> revision/refs、`read(ref)` -> resolved secret 或 rejected、`save({expectedRevision,secret})` -> saved revision/opaque ref 或 rejected。secret 不进入 metadata。文件格式 schemaVersion1/revision/entries（credentialRef/secret），单文件有界；路径按 XDG，权限拒绝宽松既有文件。写锁使用 exclusive 文件创建，锁忙拒绝；无自动破锁。持锁期间重读 CAS，临时文件0600、fsync、rename、回读，再释放锁。错误只保留结构化 code/安全文案，不转发包含载荷的异常。

项目 `ProjectConfigurationStore` 同样短锁/CAS/atomic replace；读回 canonical worktree 配置。application `ModelSettingsService` 先校验候选，若有新 key 先保存并回读凭据，再追加新 connection/model/config/profile 并保存项目。后者失败返回 rejected 保留输入；孤立 key 可保留，不声称跨文件原子。查询返回非秘密 snapshot；保存不自动应用。

### D03 — Coordinator 注入

chat-model factory 在最后构造点解析 managed credential 的明确 optionPath；原模型 DTO 只保存引用。effort 通过 capability.optionPath 注入。不得把秘密放入持久 DTO。bootstrap/doctor 使用同一解析；switch verification 使用全部 capability probe，保持 suspended、checkpoint/native window 的原顺序。失败诊断不回显 SDK credential。

### D04 — Manifest2 与模型限定重授权

WorkerProfileRef 增加完整 modelConfiguration；解析拒绝缺失或非法设置。Manifest 独立绑定 Recovery Utility profile。初始授权从项目角色 profiles 组装。execution 模式 review 从当前授权复制全部非模型字段，换模型 profiles，并绑定实际 Graph head version；批准前重读 config/graph/scope，拒绝 replanning/cancelling/未决 dispatch intents。使用既有 canonical fingerprint/CAS/record-authorization 事务追加；授权 ID 纳入该完整 fingerprint，避免相同 graph/version 碰撞。无需新 Graph Revision，不迁移预算。当前授权只控制新 Task，旧 Task 权限来自其精确绑定。

### D05 — materialization binding 与恢复

schema16 为 materialization_bindings 增加 authorization_id、authorization_version、worker_profile_ref；旧记录保持 null，不推断回填。在创建派发 intent 前记录固定绑定。Retry 沿已有 WorkerTask 的 binding 取原 authorization/profile；新角色 Task 取当前授权。unknown 使用原 OperationId 对账；原 Task 替代 Session 与 Validator repair 使用原 profile；新 Utility Task 固定创建时授权配置。结算从对应 Task binding 读取授权，仍校验 scope/run/current generation/contract/attempt。baseline reconciliation 采用相同原绑定规则；不放宽所有历史授权。

### D06 — secretless Codex launcher

Node 内部 launcher 与 nonsecret descriptor 位于隔离 CODEX_HOME，descriptor 保存固定 model configuration、credentialStore 路径、sandbox/profile 和 reporter 路径。公开 terminal command 仅 node/script/descriptor，不含 key。launcher 本地解析 credential，仅在 child env 注入；managed provider 明确 env_key/requires_openai_auth=false，避免 auth.json 优先级，Harness-login 保留原认证绑定。model、model_reasoning_effort、provider 与 options 由相同配置生成器生成，普通 Worker/只读 Finalizer/Utility/探针共用。信号与退出状态透传，不增加终端模拟器。现有 reporter 的精确 Session Binding 保持。

### D07 — TUI DTO 与角色菜单

ModelCatalog 保留 Coordinator 旧字段，新增 roles、provider/model candidate、current binding、capability/source、availability/reason 与 configuration revision；默认无新字段的 fake port 明示不可用。ModelSettingsPort 提供只读 load、显式 save、角色显式 apply；保存输入包含目标角色、connection/model/options/capability/effort/可选新 key 和 expected revision。Coordinator apply 走原 switch，Worker apply 先保存选择再完整授权 review/approve，不暗中改变运行。UI 只提交意图，scope/writer/profile identity 由宿主补齐。

#52 固定框与 identity summary、当前 Coordinator/Planning/Execution 分组、provider/model 列表和独立水平 effort、反色动作沿原定稿。Tab 切模型/effort/动作，默认返回。编辑器使用同一框与独立内存字段，key 只显示遮罩；普通 composer/IC-13 不承载 key。Esc 逐层恢复6A页面绑定；异步结果以原 invocation/Session 为归属，不抢新焦点。没有可信能力来源显示不可用。

### D08 — 证据和文档

六票来源使用 `align-tui-with-approved-prototypes/design.md` D01 的最终决议、源码、样例。新证据仅放 `artifacts/model-configuration/`，覆盖三档/颜色/图标和中文resize/save/reapprove。真实模型/Orca检查只用临时项目专用身份，精确 transcript 验证；条件跳过不能代替证据。更新 CONTEXT、AGENTS、architecture/IC03/04/05/07/08/09/11/12、README/workbench/handoff；用户已确认 CredentialStore 改变旧“不得保存密钥”约束。

## Risks / Trade-offs

明文 credential store 是用户确认的取舍，靠权限、非秘密引用与严格输出边界隔离。两个文件不具备跨文件原子事务；先存凭据可留下孤立项但不会激活错误配置。不同 SDK 的 effort/auth 参数需要显式路径，任意 provider 不猜映射。旧 materialization 缺少模型证据时阻塞恢复，不能伪造。

## Migration Plan

不自动重写用户项目配置；v1 明确拒绝，例子和测试更新到v2。SQLite 短事务迁移15→16，新字段nullable仅为可识别缺失历史。旧 Manifest1 不被当作包含模型授权，启动诊断要求重新确认。历史原型与归档报告保持只读。

## Open Questions

无阻塞决策。未实现角色和第七批偏好仍由后续批次承担。
