# 六家未注册候选交接

记录日期：2026-10-14。Change：`add-next-worker-harness-adapters`。
本工件供后续接入者续办，事实来源为[研究记录][research]、各轮原始证据和
[独立验收](verification.md)。本次仅整理已有结论，没有重新操作原生配置、Orca 或模型。

## 当前边界

六家均已完成 WorkerHarness adapter、独立报告插件维护与离线验证，均未进入生产
canonical IDs 或注册表。候选可以显式注入测试，但生产选择与派发仍拒绝。
完整真实资格必须包含四角色、Implementation 精确 resume、Validator 同 Session
续接、只读 Recovery、防护/foreground、mixed Controller 人工中断与同 Scope 重启。
完成工件或收到 `worker_done` 只证明对应的部分行为。

本 change 的 12/12 与 PASS 包含规格允许的“独立调查后有证据延期”，没有把六家
算作完整真实验收通过。新增生产注册只有 Antigravity，总八家。
四家真实探索主要使用 Orca 1.4.222；Antigravity 后来在未修改 1.4.224 上的成功
不能替代六家在新 runtime 上的重新验收。下列版本是已验证版本，不宣称当前安装版未变。

| 候选 | 已验证原生版本 | 已证明的真实进展 | 延期原因 | 重开时先解决 |
| --- | --- | --- | --- | --- |
| Kilo | `@kilocode/cli` 7.8.8 | 默认完整 TUI 的输入探针、Implementation、Validator；精确身份、实际模型、完整覆盖及工件 | Planner、精确 resume、只读 Finalizer/Recovery 未可靠启动模型轮次 | 找到可证明且可靠的原生输入/就绪路径，分别验证可写、只读与 resume |
| Kimi | 2.1.1 | Planner 工件、精确 Session、complete 覆盖及 worker_done | `usage.record.model` 来自请求 alias，缺实际响应模型证明 | 原生公开响应、hook 或 export 保留实际模型事实 |
| Hermes | banner 0.17.0；checkout `e20ff352b91623d51ae05ea586a1800aee852402` | `--cli` 的精确绑定、只读 Finalizer 原生工具与 worker_done | export 不证明完整 inactive/compacted 历史，coverage partial；缺实际响应模型证明 | 公共完整历史覆盖与响应元数据 |
| Cline | CLI 3.0.70 / SDK 0.0.92 | 本地入口、多行输入探针、Validator 精确绑定、工件与 worker_done | messages 是可覆盖的上下文快照，coverage partial；modelInfo 是客户端配置 | 公共完整历史覆盖与实际响应模型证明 |
| Meta Muse | 本机未有 CLI 真实验证 | 实现和离线验证，尚无真实角色资格 | 官方 CLI 与原生订阅登录前置条件未满足 | 准备 CLI/登录，核对原生协议与版本后补完整验收 |
| Cursor | 本机未有 CLI 真实验证 | 实现和离线验证，尚无真实角色资格 | `cursor-agent` 与原生订阅登录前置条件未满足 | 准备 CLI/登录与支持模型，补完整验收 |

## Kilo：部分角色可用，任务输入与恢复尚不可靠

已修复原生配置优先级导致的 reporter 缺失：后读的 `opencode.json` 曾覆盖
`kilo.jsonc` 的 plugin 数组，安装器现维护实际生效位置。默认完整 TUI 移除
`--mini` 后输入探针通过；Orca 已提交 preamble，候选共用 launcher 的
`activation: none` 消除额外 Enter。报告最终 export 的读取竞态也已用有界复核处理。
这些是已解决的问题，不应重新作为当前延期原因。

仍缺 Planner、Implementation exact resume、Validator 上下文续接、只读 Finalizer、
Recovery 和 mixed Controller 的完整资格。一次 Validator exact resume 能显示原历史，
但没有新任务或 launch report；只读 Finalizer 在正向就绪之后延后65秒仍导出0消息。
新只读 Recovery 的源 transcript 已 complete，Utility 自己仍为空 Session且没有
worker_done。仅有 `input_accepted`、live 或空 Session 不能证明输入进入模型。
OpenViking 插件 EROFS 是观察事实，因果关系未证明；不能靠删插件、放宽只读或固定等待
把诊断变成生产接入。

优先续办：在独立隔离场景分别证明首次可写、首次只读和 exact resume 输入交付，
保留原生 TUI、精确 Session、提交一次与完整覆盖。修复必须位于 Companion adapter/
launcher 的公开适配边界。上述路径可靠后再补同一完整矩阵和 Controller。
主要证据：[输入/报告对照][input]、[默认 TUI 矩阵][matrix]、[延期 `candidates.kilo`][exploration]。

## Kimi：精确身份和覆盖成立，实际模型证据不足

Planner 已完成工件、worker_done、精确绑定和 complete 覆盖。原生 SessionStart、
cwd 分区内的 agent wire 与 exact-ID ZIP export 的 manifest 已交叉核验；不能从
最近会话或全局日志选择身份。后续离线审计修复了 TOML hook 空行/缩进、字符串内
`#`、非法尾部字段的安装解析问题，审计已闭合。

当前阻塞是模型事实：2.1.1 的 `usage.record.model` 来自 `request.modelAlias`，
assistant 元数据也没有可用的 provider 响应模型身份。请求目标或 native config
不能替代实际响应证明。因此 Planner 行为成功没有被算为完整角色资格，其他角色、
resume、Validator 续接、Recovery 与 Controller 也没有完成完整资格。

优先续办：查验当前公开响应/hook/export 是否新增所需元数据；必须关联到同一精确
Session 的实际调用。只有找到可信来源才修改所属 adapter 的读取逻辑，再补全矩阵。
没有新来源时保持延期，不将请求 alias 或 Worker 自报提升为实际模型证据。
主要证据：[进度 `kimiPlanner`][progress]、[延期 `candidates.kimi`][exploration]、[安装审计][audit]。

## Hermes：原生只读执行成立，完整历史与模型证据不足

已调查 `--tui` 的 cwd/hook 问题，改用 `--cli` 的原生入口及 resume-capable
`pre_llm_call` 报告，公开 `sessions export --session-id ID -` 核对精确身份。
只读 Finalizer 已执行原生工具、产出工件并 worker_done succeeded。

公开 export 未能证明 inactive/compacted 全历史覆盖，结果仍为 partial；所检查
hook/export 没有实际响应模型证明。因此单个只读任务完成没有满足全生命周期资格。
四角色、精确恢复、Validator 续接、Recovery 与 Controller 的完整验收仍待补。

优先续办：确认当前 native public export/响应元数据是否补足覆盖与模型事实；
保持精确 Session 导出和未知格式拒绝。若仍是上下文快照，不把完整覆盖标成 complete。
主要证据：[续测 `roles` 中 Hermes、`cleanup.hermes`][continuation]、
[延期 `candidates.hermes`][exploration]。banner 与实际 checkout 版本都要记录。

## Cline：本地入口和 Validator 有进展，原生存储不足以证明完整资格

已实现 global JS plugin，核验安装 SDK 的 manifest，报告 host Session/cwd 并与
精确 manifest/messages 交叉证明。`--tui --yolo` 强制本地 backend，避免连接已有
hub 时丢失当前 reporter 环境或把工具执行移出只读边界。多行输入探针与真实
Validator 已成功；这些不能替代其他角色、精确 resume、Recovery 或 Controller。

当前阻塞有两项：`persistSessionMessages` 覆盖保存当前上下文，压缩/checkpoint
恢复可能裁剪，不能证明全活动历史；assistant `modelInfo` 由请求配置复制而来，
不是实际响应模型。因此 coverage 保持 partial，modelEvidence 为 null。

测试环境还留下需交接的副作用：首次只把 `CLINE_PROVIDER_SETTINGS_PATH` 传给驱动，
Orca terminal 没继承它，原 `~/.cline/data/settings/providers.json` 于
2026-10-12T12:02:31.976Z 增加无新凭据的 provider/model 选择并改变 lastUsedProvider，
未回滚。修正后的启动在命令中显式设置已批准独立文件
`~/.cline/data/settings/providers-minimax-mplan.json`，原文件随后字节不变。
后续必须核验实际 launch 环境，不把驱动环境当 Worker 环境，也不自动覆盖用户当前配置。

优先续办：公开 Session/export 具备完整历史与响应模型证明后再补矩阵；保持本地
执行、真实认证与 bwrap 只读边界。早期 `next-cline3:planner:terminal-create` 为
unknown 且缺 request ID，不能重跑该创建以“恢复”。
主要证据：[默认矩阵 `singleVariableNoEnter.clineValidator`][matrix]、
[配置副作用 `clineLaunchCorrection`][continuation]、[延期 `candidates.cline`][exploration]。

## Muse 与 Cursor：实现/离线完成，真实环境尚未准备

Muse 已实现原生 hook、UUIDv7 Session/frame 身份、精确 resume、目录和 Recovery
配方。审计修复未知/损坏 retained records 被忽略以及 workspace 冲突准入；未知记录
和冲突现在拒绝，独立复核已关闭。Cursor 已实现原生 hooks、精确 transcript、
`--resume ID`、目录和 Recovery 配方。两者离线 fixtures 通过，不意味着安装版行为已验证。

延期源于本机官方 CLI 和原生订阅登录未满足；两者没有本轮真实四角色、恢复或
Controller 证据，也没有可续接的真实 Task/Session。不能写成“测试失败”。
Cursor 编辑器 BYOK 文档不能证明 CLI 支持任意 MiniMax endpoint，模型选择需要实测确认。

优先续办：在获准安装和原生登录后核对 CLI 版本、可执行名、报告协议与支持模型，
独立安装 reporter，再开始完整隔离验收。当前 `HARNESS_MATRIX` 和
`installAcceptanceCandidates` 尚未列入 muse/cursor，需在测试 helper 内显式新增
已批准模型绑定与候选注入；仅设置 `_HARNESSES=muse,cursor` 会被拒绝。
生产 ID/注册表仍等待全部真实资格通过。
主要证据：[研究原生事实与后续验收][research]、[延期 `candidates.muse/cursor`][exploration]、
[Muse 身份/覆盖审计][audit]。

## 保留现场与续接身份

下表是历史证据定位，**不是2026-10-14实时进程库存**。开始续办前，仅通过公开 CLI
在精确 Run/worktree 下核验仍存在的资源、原 receipt、incarnation 和 liveness。
已关闭终端不重新打开以冒充原 Worker，未知存活不推断退出。

- 主要 fixture：`/var/tmp/orca-harness-acceptance-ncWTVr`；历史 Run
  `run_d394e13d9181`，2026-10-12 coordinator handle
  `term_fc9e2f9f-3ad7-4d49-9513-aab36e4f49b9`，consumer generation 2。
  具体 repository/worktree selector 与 public query receipt 在[续测证据][continuation]。
- Kilo 旧创建：OperationId `next-kilo3:planner:terminal-create`，backend request
  `15d00764-778b-4006-889b-4fd3778e4a38`，request-show absent。
  absent 不证明没有副作用；原 unknown 不换 ID 重试。
- Cline 旧创建：OperationId `next-cline3:planner:terminal-create`，unknown，
  旧脚本未留 request ID；现有证据不足以完成对账，保留阻塞。

| 历史场景 | Task / Dispatch | 精确原生 Session 或请求身份 | 当时结果 / 资源状态来源 |
| --- | --- | --- | --- |
| Kilo Implementation | `task_29a89e2ce115` / `ctx_b7b9763255f0` | `ses_ecf8d8d22ffeI7sT04RqTmrk0O` | 模型、complete、工件通过；终端已结算关闭，[matrix] |
| Kilo Validator | `task_563e73a62b0b` / `ctx_084559fbdac7` | `ses_ecf88a937ffeN4xv5Qd6dPY65f` | 模型、complete、工件通过；终端已关闭，[matrix] |
| Kilo exact resume | `task_10475bca8c41` / `ctx_5ec18b3c01e5` | 请求原 Validator Session | 新报告/任务轮次缺失，原 `term_6c83aaef-8ea4-4eb3-bc56-2eae1d6bbfce` 保留，[matrix] |
| Kilo只读 Recovery | `task_669c822504ef` / `ctx_a7c88f86524f` | `ses_ecf473907ffeGyKFEedQerK2Fi` | export 0消息、无worker_done；原 `term_fbde4b8b-1a8a-486e-92f9-523b7cd92a5c` 保留，[exploration] |
| Kimi Planner | `task_8f92bac42ea6` / `ctx_e7c4598ce9f8` | `session_d1d1e2cc-c89d-4c8a-aade-c1ce1802b358` | 行为/身份/覆盖成功，modelEvidence null；CLI exited/0，旧close回执未证实，[progress] |
| Hermes Finalizer | `task_18db1dbe2f08` / `ctx_00fe2e1b29e5` | `20261012_201125_de271b` | coverage partial、modelEvidence null；精确终端已关闭，[continuation] |
| Cline Validator | `task_9e6332b13c96` / `ctx_f452547b015a` | `1791814275714_4auqg` | 工件/身份成功，partial、modelEvidence null；终端已关闭，[matrix] |

更多 Kilo Planner/Finalizer/65秒对照以及 Cline 未结算尝试的完整请求、终端和回执
保留于 `[matrix].additionalAttempts/preservedUnsettled` 与 `[continuation].roles/mutations`。
backend envelope ID 和 durable mutation request ID 不是同一字段，不互相替代或补猜。

## 后续执行顺序与完成条件

1. 先核验上述原生版本和阻塞条件是否改变；历史上游源码事实不冒充安装版 runtime。
2. 对旧现场只按原身份查询/对账。独立新场景先隔离身份与工作区，不重放旧 unknown、
   不补 Enter、不替换已接受 prepared 创建；接管仍需同 handle 的 tui-idle satisfied/running。
3. 在所属 adapter/launcher 内解决可解决的原生差异。禁止 patch/构建/替换定制 Orca、
   读写 Orca DB/私有 RPC、放宽精确身份、完整覆盖、只读或模型事实标准。
4. 补足单项事实后，逐家串行补完整矩阵及 mixed Controller 的中断/恢复/重启。
   失败、未运行和通过分别存证；保存预算、Task/Attempt/profile/授权绑定。
5. 全部通过才修改生产 canonical IDs、registry、probe executable、目录 caller、
   角色选择和支持文档；复用既有离线/全量检查与限定独立审计。
6. 仅在明确终态且精确身份成立后公开回收已结算测试资源；保留 unknown 和原失败记录。

现有四家原生目标为中国 MiniMax M Plan `MiniMax-M3.1-Flash-Preview`，原生认证由
harness 自己提供；保留用户默认值，不从 Coordinator CredentialStore 取 Worker 密钥。
不在本交接文件保存密钥或复制带凭据的配置。

可先复查离线行为（不启用真实开关）：

```sh
pnpm exec vitest run tests/adapters/agents/{kilo,kimi,hermes,cline,muse,cursor}-harness.test.ts tests/adapters/agents/worker-harness-reporting.test.ts --maxWorkers=4
```

真实验收入口是 `tests/acceptance/worker-harness-matrix.test.ts`，用
`ORCA_COMPANION_REAL_ACCEPTANCE=1`、精确 `_HARNESSES`/`_ROLES` 与明确
`ORCA_CLI_COMMAND` 选择隔离场景；默认会建新的 fixture，不用于盲目恢复旧 Run。
`tests/acceptance/worker-harness-controller.test.ts` 是另行 Controller 闭环入口。
Muse/Cursor 先补测试 helper 的显式绑定。重开真实测试会产生外部操作与模型费用，
本次文档补充没有执行这些入口，也没有安装 CLI 或改变账号状态。

[research]: ../../../docs/research/next-worker-harness-adapters.md
[exploration]: ../../../artifacts/next-worker-harness-adapters/exploration-20261012.json
[matrix]: ../../../artifacts/next-worker-harness-adapters/default-tui-matrix-20261012.json
[input]: ../../../artifacts/next-worker-harness-adapters/input-reporting-20261012.json
[continuation]: ../../../artifacts/next-worker-harness-adapters/continuation-20261012.json
[progress]: ../../../artifacts/next-worker-harness-adapters/implementation-progress-20261011.json
[audit]: ../../../artifacts/next-worker-harness-adapters/audit-20261013.json
