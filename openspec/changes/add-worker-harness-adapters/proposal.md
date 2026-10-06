## Why

Companion 目前只能派发 Codex Worker：生产接线在五个 runtime 中硬编码 `harness !== 'codex'`，配置、模型设置 UI 与 doctor 探针都只有 Codex 字段。本机已安装 claude、opencode、pi、omp，用户已批准下一批同时支持这四者；不先建立应用层 Worker Harness 端口与显式注册表，继续添加或替换 harness 都会重复修改核心生命周期。

## What Changes

- 新增应用层 `WorkerHarness` 端口与 bootstrap 显式注册表：codex、claude、opencode、pi、omp 五个条目，未知 harness id 在派发前结构化拒绝。
- 新增四个 harness adapter 的隔离启动、精确 provider session 身份、精确 resume、只读启动与能力探测：claude（SessionStart hook + exact id/path）；opencode 2.0.21（隔离 XDG `--standalone` 私有子进程、公开 session metadata、`/api/session/:sessionID/message` limit/cursor 分页，禁止直接读 DB 或按终端猜）；pi 1.0.0（原生 `session_start` extension 上报 id/path 与 active branch header）；omp 18.4.10（extension 等待真实 session 文件出现并回读 exact id/fullpath）。
- 认证：managed 凭据由 bootstrap 注入的 CredentialStore 解析且 secret 只进子进程环境；`harness_login` 为显式 auth source，使用隔离状态根内的登录态，不修改用户全局 harness 配置与凭据。
- 只读角色（Finalizer、Recovery Capsule Utility 与基线只读路径）共用 Ubuntu bwrap 生产/probe 包装器：仓库与 Git 只读，仅精确 harness state 与 tmp 可写，coordination.sqlite 不可写。
- 配置 schema 3 additive：`ProviderConnection.nativeWorker` 按 harness 判别（providerId/baseUrl/api where applicable），保留 codex 字段与旧指纹省略；`SaveModelSettingsInput.harness` 可选，省略时保留角色既有 harness，首次使用取 `execution.harness`；TUI 每角色显式选择 harness/provider。
- doctor 按实际 harness 能力核验，移除 `harness !== 'codex'` 与按 harness 名称的 blanket 门禁。
- 测试覆盖现有参数化合同与真实回归缺口；真实集成在显式隔离的 Orca 项目按四个固定模型跑 planner→implementation→validator→finalizer、resume/recovery 与混合角色。

## Capabilities

### New Capabilities

- `workers/harness-adapters`: Worker Harness 端口、显式注册表与四个新 harness 的隔离启动、精确会话身份、精确恢复、认证来源与跨 harness 只读包装器合同。

### Modified Capabilities

- `workers/harness-binding`: Session Binding 与 launch 要求从 Codex 扩展为任意已注册 harness。
- `configuration/model-settings`: 配置使用 schema 3 并接受可选 `nativeWorker` 连接与逐角色 harness 选择。
- `cli/environment-diagnostics`: doctor 按每个被配置引用的 harness 的实际能力核验。
- `orchestration/read-only-worker-execution`: 只读能力探测与生产启动按 harness 共用同一受限包装器。
- `recovery/worker-sessions`: 恢复角色范围与 transcript 证明从 Codex 专属扩展为逐 harness 精确证明。
- `tui/planning-workspace`: 模型页在 #52 定稿上增加逐角色 harness/provider 与原生连接编辑。

## Impact

直接前驱：已归档 `complete-coordination-runtime-wiring`（`openspec/changes/archive/2026-10-06-complete-coordination-runtime-wiring/`）；规划基线 HEAD `c1f9a0a`。涉及 domain/model-configuration、application 配置与恢复用例、agents adapters、bootstrap 五个 runtime 接线与 doctor、TUI 模型设置、相关测试，以及后续任务内的 domain/architecture/IC-07/08/09/14/orca-compatibility/handoff/AGENTS 文档同步。不新增依赖、不改 SQLite schema、不改 Coordinator 模型（仍为 LangChain）；Ubuntu 以外平台不标记支持。
