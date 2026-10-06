## Why

Companion 目前替 Worker 保管 provider 连接、凭据引用、隔离 HOME/XDG 与登录态副本，并生成各 harness 的原生 provider 配置。这让 Companion 成为 Worker 模型与认证的第二 owner，与「Worker Harness 提供模型、认证、代码操作和真实会话」的产品边界冲突，也让每次 harness 变化都要改 Companion 的凭据与配置代码。用户已决定彻底移除 Worker 凭据管理：Coordinator 的 LangGraph 连接与凭据继续保留，Worker 只按角色选择 harness、模型与 effort，其余交给 harness 自身。

## What Changes

- **BREAKING** 项目配置升为 schema 4，Execution Authorization Manifest 升为 v4：Worker Profile 改为 `{profileRef, role, harness, modelSelection}`，`modelSelection` 为 `{model, effort, effortCapability, catalogSource}`；不再有 connection、modelRef、modelOptions 或 credentialRef。旧 schema 1/2/3 与 Manifest 1/2/3 明确拒绝，不迁移、不自动改写；既有孤儿凭据不删除。
- **BREAKING** `ProviderConnection` 只删除 Worker-only 的 `codex` 与 `nativeWorker` 字段；`credential.harness_login`（Coordinator provider integration 自身的环境认证路径，沿用旧命名）、managed credentialRef、provider integration 与 modelOptions 合同保持不变，本 change 不得改动 Coordinator 凭据合同。
- 认证与状态根归还 harness：删除 Companion 的 Worker 隔离 HOME/XDG、认证文件复制/链接与原生 provider 配置生成；Worker 启动继承真实 launch `process.env`，不 set/unset 原生环境变量。共享 launcher v2 删除 codexHome/credential/environment/unset；resume 的 `expectedStateRoot` 只核验不 override。
- 新增 `worker-runtime.ts`：从真实 launch 环境解析该进程的原生有效路径（NativeEnv），经 `runtimeReportPath` 序列化非 secret paths，供报告、绑定、恢复与只读包装器使用；不从 Session report 反向生成环境，不保存整个 env、不保存秘密。Session 以精确 ID + transcript + runtime roots 绑定，不猜 latest；恢复沿用原 launch report/binding。
- `WorkerHarness` 端口移除 CredentialStore 与 credentialStorePath，`stateRoot` 只表示 Companion reporter/launcher 工件目录；新增逐 harness 的原生模型目录有界、可取消查询（codex `debug models`、Claude streamJSON control_request `list_models` 无 prompt、OpenCode `models`、pi 原生 availability/thinking、omp `models --json` 实际 thinking）。
- 逐 harness 启动机制：Codex 每次调用 inline `-c` hooks 且 `--no-daemon`；Claude `--settings` 叠加只含 report/security，保留 native setting sources；pi/omp 用各自 extension；OpenCode `--standalone` 公开 Session API。`process-runner.ts` 增加可选 bounded stdin，供 Claude 控制协议使用，不引入 shell。
- 只读边界保持严格：bwrap 包装器继续让仓库、Git、Git common dir 与协调库拒写，真实 native 所需 state 目录与 Companion 工件目录可写；overlap 无法证明时能力判为 unavailable，不放宽权限。
- TUI 沿 #52 定稿：模型页按角色展示原生目录候选与独立 effort，默认返回、显式应用；Worker 角色不再有连接、凭据、API key 或任意 options 编辑，Coordinator 表单保留。目录查询失败时允许手填 native exact ID，标记未验证且不得捏造 effort。
- 同步 AGENTS.md、CONTEXT.md、README.md、docs/architecture.md、docs/interface-contracts.md、docs/orca-compatibility.md 与 TUI 交接文档；复用现有 configuration/authorization/adapters/bootstrap/TUI/acceptance 测试并新增 worker-runtime 与 worker-model-catalog 检查。

## Capabilities

### New Capabilities

<!-- 本 change 不新增 capability：能力变化全部落在既有 capability 的需求修改上。 -->

### Modified Capabilities

- `configuration/model-settings`: 项目 schema 4、Worker Profile 的 `modelSelection`、Coordinator-only `ProviderConnection`、旧 schema 拒绝与目录来源核验。
- `workers/harness-adapters`: 端口与注册表移除凭据与隔离状态根；新增原生模型目录查询；认证来源隔离需求移除。
- `workers/harness-binding`: launch 解析 `modelSelection`；Session Binding 记录精确 runtime roots 与原生认证事实。
- `planning/execution-authorization`: Manifest v4 绑定 `modelSelection`；物化绑定继续固定原授权/profile；旧 Manifest 拒绝。
- `recovery/worker-sessions`: 恢复沿用原启动报告的 runtime roots 与精确身份，删除隔离状态根与登录态复制叙述。
- `orchestration/read-only-worker-execution`: 只读探针与生产按 harness 共用包装器，真实 native state roots 与 Companion artifacts 可写，重叠不可证明即不可用。
- `tui/planning-workspace`: 角色模型设置改为原生目录候选与 effort 选择，Worker 不再编辑连接/凭据。
- `cli/environment-diagnostics`: doctor 按被引用 harness 核验可执行版本、精确会话身份与 roots、模型目录与只读包装器，不再核验认证来源或隔离状态根。

## Impact

直接前驱：已归档 `add-worker-harness-adapters`（`openspec/changes/archive/2026-10-06-add-worker-harness-adapters/`）；基线 HEAD `f445aee37dfe0a6514b569678754fde3481ee0fb`，合同基线 `predecessor-contract`。

涉及 domain 模型配置与授权、application 配置/端口/启动用例/恢复、agents adapters（launcher、reporter、catalog、只读包装器）、orca-cli process-runner、bootstrap 全部 Worker 接线与 doctor、TUI 模型设置端口与组件、preview fixture、相关测试，以及上述文档。不新增依赖、不改 SQLite schema、不改 Coordinator 模型与 `CredentialStore`、不改 Orca 公开调度身份、预算或原 Task 授权固定；Ubuntu 以外平台不标记支持。
