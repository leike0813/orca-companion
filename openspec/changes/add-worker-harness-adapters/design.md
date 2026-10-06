## Context

Companion 当前只有 Codex Worker Harness。生产接线在五个 runtime 中以 `harness !== 'codex'` 阻断非 Codex profile（`foreground-planning-runtime` 的通用/Planner/Finalizer/Baseline 四处、`execution-runtime` 的 Utility 与替代 Session 两处），并把字面量 `harness: 'codex'` 写入 Session Binding；`providerConnectionSchema.codex` 是必填可空块，TUI 模型设置只有三个 Codex 字段，doctor 只有 Codex 形状的只读探针。Manifest 以 `manifest_json` TEXT blob 存储，`coordination.sqlite` schema 20 不需要迁移。主规格 `configuration/model-settings` 仍写 schema v2，而代码与 AGENTS.md 已是 schema 3，本 change 以代码为事实源在 delta 中修正为 schema 3（仅记录漂移，不在本 change 重写主规格正文）。

本机事实：claude 2.1.289、opencode 2.0.21、pi 1.0.0、omp 18.4.10 均已安装；模型绑定由用户固定为 claude `MiniMax-M3.1-Flash-Preview`（Opus alias）、opencode `minimax-cn-coding-plan/MiniMax-M3.1-Flash-Preview`、pi `minimax-cn/MiniMax-M3`、omp `minimax-code-cn/MiniMax-M3.1-Flash-Preview`。

## Goals / Non-Goals

**Goals:** 用应用层端口与显式注册表承载五个 harness；四个新 harness 具备隔离启动、精确会话身份、精确恢复与只读执行；配置、TUI 与 doctor 不再假设 Codex；现有生命周期、预算、Delivery、Recovery 语义不变。

**Non-Goals:** 不新增 npm 依赖或原生 SDK；不改 Coordinator 模型（仍为 LangChain）；不新建状态机、不改 SQLite schema；不读 harness 数据库、不写用户全局配置；不实现 M3 的多机/后台/发布能力；Ubuntu 以外平台不标记支持。

## Decisions

**D1 WorkerHarness 端口归属与形状。** 端口定义在 `src/application/ports/worker-harness.ts`，闭合五类能力：`prepareLaunch`、`prepareResume`、`proveSession`、`prepareReadOnlyLaunch`、`probe`。请求携带已批准 profile、角色、launchId、worktree 与状态根；返回值复用现成 `PreparedTerminalStrategy`，因此 `prepareWorkerLaunch`/Orca `worker-start --terminal` 路径不变。**权威来源：** 角色 profile 的不可变绑定。**失败关闭：** 未知 harness、缺失能力或缺失凭据在写盘前拒绝。**备选：** 在每个 runtime 内做 `switch (harness)`——会复制启动逻辑，否决。

**D2 显式注册表。** `src/bootstrap/worker-harness.ts` 显式列出 codex、claude、opencode、pi、omp 五个实现；未注册 id 结构化拒绝；不做目录扫描或运行时自动发现。单实例与 `CredentialStore` 一样由 bootstrap 注入，避免「配置在但运行期读不到」。

**D3 会话身份矩阵（新建）。**

| harness | 身份证据 | transcript 来源 | 新建 id 方式 |
|---|---|---|---|
| claude | SessionStart hook 上报 session id + 精确 `projects/<cwd-munged>/<uuid>.jsonl` | 同 hook path，JSONL 按 sessionId + 行偏移有界读 | `--session-id <uuid>` |
| opencode | 隔离 `--standalone` 私有子进程的公开 session metadata：新建经 `POST /api/session`（精确 id、location、model）回读确认，列表用 `session.list` operation 带 `--param` 穷尽并证明候选唯一 | `/api/session/:sessionID/message`（raw GET query string limit/cursor 分页） | `--session <id>` 显式指定 |
| pi | 原生 `session_start` extension 上报 id/path + active branch header | 上报的 JSONL path | `--session-id <id>` |
| omp | extension 等 `existsSync` 确认真实 session 文件后回读 exact id/fullpath；transcript 首行 `title` v1 是文件级 metadata | 回读的 JSONL fullpath | 无 `--session-id`：启动后回读并持久化 |

**失败关闭：** 缺失、冲突、多候选或观察早于 Dispatch 窗口即不可用；禁止 cwd、mtime、终端输出、「最近会话」与直接读库。

**D4 精确恢复矩阵（resume）。** claude `--resume <uuid>`；opencode `--session <id>`（同一隔离状态）；pi `--session <path|id>`；omp `--resume <exact fullpath|id>`。禁止 `--continue`、picker、前缀模糊匹配；无法证明原身份时阻塞，替代 Session 由 Recovery 正常路径创建。opencode resume 复用原 Session 的报告路径（`resumeSessionPathsUnder`）并在公开 API 重新证明后刷新该报告的 `observedAt`；报告时间戳只表示本次核验时刻，不改变 Session 身份。

**D5 nativeWorker 连接（配置 schema 3 additive）。** 已批准形状为按 harness 判别的封闭联合：`providerId` 必填（该 harness 的 provider 路由身份），`baseUrl` 可选（端点覆盖），`api` 可选且取值限于 `anthropic-messages`、`openai-completions`、`openai-responses`。字段一律非秘密，未知键拒绝。`nativeWorker` 整体可选，未出现时序列化保持省略，因此旧记录与旧 fingerprint 不变；每个 adapter 在启动前核验本 harness 实际消费的字段齐全，缺失即拒绝。

**D6 逐角色 harness 选择。** `SaveModelSettingsInput.harness` 可选：省略时保留该角色既有 profile 的 harness；无既有 profile 时取 `execution.harness`；显式值必须是注册表内 id。保存不改当前 Session/Manifest/在途 Task；执行期变更经完整 Manifest 重新批准（沿用现有流程，不新建授权路径）。

**D7 认证来源。** managed：bootstrap 的单一 `CredentialStore` 解析 credentialRef，secret 只注入子进程环境；每个 adapter 自持环境变量名常量，pi 的 provider `apiKey` 需要 `$ENV` 形式引用，OMP 写裸变量名。`harness_login`：显式 auth source，使用隔离状态根内的登录态副本/链接（如 claude 复制用户的非秘密 settings 与模型 alias 映射、链接或复制登录文件）。claude 的显式 settings 只放行 scope 内的 orchestration 命令（`send` 携带 dispatch capability，由 Orca 侧校验），不开放其它任意 shell。两者都不得读写用户全局配置；缺凭据或缺 auth source 阻塞，无 fallback。

**D8 隔离状态根。** 每个 launch 使用独立的 private per-launch root（`<stateRoot>/<launch-digest>`），按 launchId 隔离并与 worktree 绑定。当前生产对普通 native 角色沿用既有 Codex 路径政策：root 落在 Git common dir 的 Companion 私有目录（`bootstrap/worker-harness.ts` 的 `sessionPaths`/`workerSessionPathsUnder`），不需要新增配置；真实验收 fixture 显式传入自己的 private state root。`<worktree>/.companion/<harness>/<digest>` 只是调用方完全不传 stateRoot 时的回退，本 change 不把它写成已实现。只读角色状态根同在 Companion 私有目录，并使用状态根内的可写 `tmp`。opencode 使用隔离 XDG（`XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_CACHE_HOME` 指向状态根）并以 `--standalone` 启动私有子进程，不连接用户后台 server；2.0.21 隔离实测：原生 config 顶层 `providers`（复数）声明 provider，provider 的 `settings` 承载 `baseURL`/`apiKey`（managed 只写 `{env:<VAR>}` 变量名并登记 `env`），`package` 选择原生实现（`anthropic-messages` → `@opencode/ai/providers/anthropic`，`openai-completions` → `@opencode/ai/providers/openai/chat`，`openai-responses` → `@opencode/ai/providers/openai/responses`），Anthropic 的 base root 补成 `/v1`；完整 TUI 在 provider 目录初始化期间会覆盖预建 Session 的模型；生产采用公开 `opencode mini --standalone --model <provider/model> --session <id>` 精确绑定，隔离 config 同时声明默认模型、自动许可和仅允许获批 provider 的 `experimental.policies`。新建 Session 走公开 `POST /api/session`（精确 id、location、model）并回读核对；列表用 `session.list` operation 带 `--param`（raw GET 忽略 `--param`）；消息读取用 raw GET `/api/session/:id/message` 的 query string `limit`/`cursor`（不存在 `session.messages` operation）。早期侦察的 SQLite 存储与模型缓存结论不再适用。provider/model 在该隔离 config 中显式声明；真实验收仍必须由运行时事实证明目标模型可用，不可用则如实 blocker，不换模型。omp 以 `<stateRoot>/home` 作为隔离 `HOME`，把 daemon 状态收进 launch root；`--config` 只是设置 overlay（`startup.setupWizard:false`、`tui.titleState:false`），模型 registry 另由 agent dir 的 `models.json` 提供（OMP 启动后迁移为 `models.yml`）；公共 extension 在 `session_start`/`agent_start`/`agent_end` 设置 OMP ready/working 标题供 Orca 判 readiness。

**D9 只读包装器。** 新增 `src/adapters/agents/read-only-execution-wrapper.ts`：以 bwrap 包装 harness 启动命令，仓库与 Git 事实只读，仅写精确状态根与 tmp，coordination.sqlite/checkpoints.sqlite/canonical 工作区不可写；生产启动与 `probe` 使用同一包装器与同一启动描述符。挂载顺序为 `--ro-bind / /` → 条件 `--tmpfs /tmp` → 精确 `--bind` 状态根（可另加 reporter 目录）；`/run` 保持根挂载只读，保留 DNS symlink 与 runtime socket，独立 tmpfs 会以 `bwrap: Can't create file at /etc/resolv.conf` 失败；workspace、状态根或 reporter 落在 `/tmp` 之下时放弃该 tmpfs。**权威来源：** 实际执行探针（读得到、写被拒、宿主回读未变）。**失败关闭：** 包装器不可用即结构化 blocker。

**D10 接线替换。** 五个 runtime 的 `!== 'codex'` 门改为按 profile.harness 从注册表解析；字面量 `harness: 'codex'` 改为绑定 profile 的真实 harness；`baseline-reconciliation-runtime` 不再以 Codex launcher 签名定型。Codex 行为保持逐字节一致（回归由现有 Codex 测试证明）。

**D11 恢复与 Validator 接缝复用。** Recovery/Validator 同会话修复/集成续接继续走现有应用用例，只把「恢复/续接」的实现换成注册表项的 `proveSession` 与 `prepareResume`，不新增状态或预算。恢复必须区分两条路径：原 exact Worker 仍存活时只重观察原 terminal/session 并重新证明同一身份，保持原 Session/Segment，零新派发、零预算；只有确认退出或身份不可证明才创建替代 Dispatch/Binding/Segment，并沿原路径消费 Recovery 预算。真正需要重新 launch 的 Validator 续接与集成续接用注册项 `prepareResume`（精确 session id/path）；修复—复验仍在同一真实 Session 内继续，跨 harness 语义相同。

**D12 doctor 与授权审阅。** doctor 核验配置引用的每个角色 profile（`MODEL_PROFILE_ROLES` 中当前存在 profile 的角色），逐 profile 输出结论并复用同 harness 的探针结论；未配置的角色不假装核验过，未知或缺失 native 连接 fail closed。只读能力缺失只阻塞依赖该 profile 的角色，禁止按 harness 名称的 blanket 门禁。

**D13 失败关闭清单。** 未注册 harness、缺失能力、缺失凭据、身份冲突/陈旧、包装器不可用、状态根不可隔离 → 结构化 blocker；unknown 沿既有 OperationId 对账，不换 ID 重试。

## Risks / Trade-offs

- **opencode 2.x 服务模型**：子命令默认连后台 server。取舍：只走隔离 XDG + `--standalone` 私有子进程与已实测的公开接口（新建 `POST /api/session` 并回读、列表 `session.list` operation 带 `--param` 的 `{data, cursor}` 形状、消息 raw GET 的 limit/cursor 分页）；raw GET 形式的列表忽略 `--param`，不能用于枚举；旧的 SQLite/模型缓存结论已按运行时证据否决。若隔离运行时仍无法证明目标模型或会话身份，按 blocker 收口，不改模型。
- **bwrap 宿主可用性**：本机已有可用记录（AppArmor profile 加载后），但内核/发行版差异会使其失败。探针必须真实执行，不把 `bwrap --version` 当证据。
- **状态根残留**：普通 native 角色的 private per-launch root 当前落在 Git common dir 的 Companion 私有目录（与只读角色同类），不能假定随 worktree 回收，需显式清理，否则累积；只有调用方显式传入的 worktree 内 root 才随 worktree 回收。接受该成本以换取不污染被检查工作区。
- **CLI 版本漂移**：四个 CLI 是外部依赖，升级可能改变字段形状。adapter 逐项核验身份事实，未知形态 fail closed；升级纳入后续独立变更。
- **真实验收成本**：四 harness p-i-v-f 端到端耗时高。只在显式隔离项目运行，普通测试不触碰真实 provider。

## Migration Plan

配置为 additive 变更：schema 3 继续接受未含 `nativeWorker` 的记录，无需改写用户文件；`coordination.sqlite` 与 checkpoint 保持 schema 20/3 不变，无迁移。实施顺序：端口与注册表 → Codex 迁移回归 → 四个 adapter → 认证/状态根 → 只读包装器与 doctor → 运行时接线 → 配置/TUI → 测试与真实隔离验收 → 文档同步（domain/architecture/IC-07/08/09/14/orca-compatibility/handoff/AGENTS，属本 change 的后续任务）。不回滚已归档 change 的历史结论。

## Open Questions

无。
