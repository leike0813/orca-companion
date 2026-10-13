# 新一批 Worker Harness 接入

对应 change：`add-next-worker-harness-adapters`。本页记录本轮资格；前驱的候选调查与 PASS 保留原验证范围。

基线 HEAD 为 `13b203f62bbb68a60456c5acd7d28e4c54c625a4`，直接前驱已归档。Orca CLI/runtime 为 1.4.222，Ubuntu 使用 `orca-ide`。submodule 固定 `cc5c85fb7a43ed52c6cd29157210020cd769d84c`；七个候选均有上游 builtin identity，但生产注册仍只有 codex、claude、opencode、pi、omp、command-code、qwen-code。

## 原生事实与当前验收

| 候选 | 版本依据 | 精确会话路径 | 本轮真实结果 |
| --- | --- | --- | --- |
| Antigravity | `agy --version` 1.3.3 | hook conversation ID，精确 cache/history metadata 与 `brain/<ID>/.system_generated/logs/transcript_full.jsonl` 交叉核验；`--resume ID` | gemini-3.8-flash-medium 四角色、implementation resume、Validator 原 Session 上下文续接和新 Recovery Utility 完整通过。mixed Controller 阻塞于原 prepared terminal 的 tui-idle 核验，未注册。 |
| Kilo | `@kilocode/cli` 7.8.8；源码 tag [e2887f0](https://github.com/Kilo-Org/kilocode/tree/e2887f08e5a6394299c810ba508f358aaf4c5bc3) | 原生 session plugin；`kilo export ID --pure` 独立核验 ID/cwd；`--session ID` | 默认完整 TUI 的 Implementation、Validator 与输入探针通过；Planner、精确 resume、只读 Finalizer/Recovery 无可靠模型轮次。延时对照仍为空 Session，延期，未注册。 |
| Kimi | `kimi --version` 2.1.1 | 原生 SessionStart；确定的 cwd 分区路径与 exact-ID ZIP export 交叉核验 manifest/wire | Planner 的精确绑定、工件、worker_done 与覆盖通过；usage.model 只保留请求 alias，缺实际响应模型事实。延期，未注册。 |
| Hermes | CLI banner 0.17.0 / e589b739；实际 checkout `e20ff352b91623d51ae05ea586a1800aee852402` | resume-capable pre_llm_call hook；公开 `sessions export --session-id ID -` | `--cli` 修复 cwd，真实只读 Finalizer 的精确绑定、工具和 worker_done 通过；export 不证明 inactive/compacted 全历史，coverage partial，缺实际响应模型事实。延期，未注册。 |
| Cline | `cline --version` 3.0.70 / SDK 0.0.92 | global JS plugin 的 host Session/cwd 与精确 manifest/messages 交叉核验；`--id ID` | `--tui --yolo` 本地入口、输入探针、真实 Validator 精确绑定和 worker_done 通过；messages 是可覆盖的上下文快照，coverage partial，modelInfo 是客户端配置。延期，未注册；旧 unknown 不重放。 |
| Muse | 本机 `muse` 不存在；官方格式离线 fixtures | 原生 hook、UUIDv7 对应 Session 与消息 frame；按 ID resume | 离线实现；真实验收延期，未注册。 |
| Cursor | 本机 `cursor-agent` 不存在；官方格式离线 fixtures | 原生 hooks、精确 Session transcript 与 `--resume ID` | 离线实现；真实验收延期，未注册。 |

Antigravity 详细身份、模型、native usage、resume 与失败 Recovery 见[资格证据](../../artifacts/next-worker-harness-adapters/antigravity-qualification-20261011.json)。Kilo/Kimi/Hermes 各次失败也保存于 `artifacts/next-worker-harness-adapters/ip04-*.json`，不把原生工件完成等同于 Companion Session 验收通过。

Kilo 的插件事件依据为固定版本 [session schema](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/schema/src/v1/session.ts#L618) 与 [发布点](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/core/src/session.ts#L244)。compiled Bun 的 `process.execPath` 不是 Node；插件显式调用安装报告器时的 Node 路径，导出使用 `--pure` 避免递归加载插件。coverage 必须对应可读快照中的实际 messages，不能用 fresh export 的边界替旧快照签完整覆盖。

Kilo 启动使用默认完整 TUI 与本次进程的 `KILO_NO_DAEMON=1`，保留 HOME、模型、认证和只读包装器。`@kilocode/cli` 的公开 `--mini` 是另一种简化界面，默认关闭；其验收不能代替默认 TUI。[mini 恢复分支](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/opencode/src/cli/cmd/run.ts#L1202)可能连接已有 daemon，源码支持该环境变量禁用连接，CLI help 未列出它。精确恢复与权限边界仍需真实验收。旧尝试 Task `task_07edbe46400e` 的 terminal-create request `15d00764-778b-4006-889b-4fd3778e4a38` 仍为 unknown；公开 request-show 的 absent 不证明没有副作用。[旧证据](../../artifacts/next-worker-harness-adapters/kilo-mini-attempt-20261011.json)保留原操作身份，未重放。

Kimi 2.1.1 的 native wire 位于 `sessions/wd_<cwd basename slug>_<normalized cwd SHA256 前12>/<ID>/agents/<agent>/wire.jsonl`；manifest 只在导出 ZIP 内。读取在导出前后核验全部 agent wire 的稳定快照与 protocol 1.5，拒绝活动历史缺失或变化。`agent.message.appended` 的 assistant 元数据只记 `agent-loop`；`usage.record.model` 来自 `request.modelAlias`，不能当作 provider 返回的模型 ID。

Antigravity Recovery Session 的 step 8、57 是异步启动时留下的 RUNNING 快照，后续同一完整 Task ID 分别有 SYSTEM 取消和完成通知。事件终态可对应，但尚未取得可靠的原生覆盖协议；当前完整覆盖判定仍拒绝，不将模型完成通知当作 transcript 完整证明。

## 独立准备与默认值保护

报告插件通过 `pnpm build` 后的独立命令管理：

```sh
node scripts/worker-harness-reporting.mjs install --harness <id>
node scripts/worker-harness-reporting.mjs status --harness <id>
node scripts/worker-harness-reporting.mjs uninstall --harness <id>
```

仅维护 Companion 自有条目；Worker 启动只检查。普通原生启动没有可信 launch reporter 时不写报告。报告不含 secret。安装遇到内容冲突、符号链接、权限或可检测的并发改写时拒绝；短锁只协调 Companion 安装器，不能保证与所有原生配置 writer 跨进程原子 CAS。

用户批准为四家独立新增中国 MiniMax 目标配置，保留默认值和认证：

- Kilo：追加 provider `minimax-cn-coding-plan`，认证引用原生 `MINIMAX_CN_API_KEY` 环境变量；选择 `minimax-cn-coding-plan/MiniMax-M3.1-Flash-Preview`。
- Kimi：追加同名 provider 与目标模型 alias；认证引用同一环境变量，保留 `default_model`。
- Hermes：复用既有 `minimax-cn` provider/auth，以 invocation model override 选择 Flash，保留原默认模型。
- Cline：目标连接保存于独立的用户级 `providers-minimax-mplan.json`，权限 0600。真实验收仅给该进程设置公开的 `CLINE_PROVIDER_SETTINGS_PATH`，保留 HOME、native data/auth 与插件。原 provider 文件不变；CLI 会保存最后使用 provider，因此不能直接向原文件追加后启动再回滚默认值。adapter 使用 provider/model 选择语法，转换为原生 `--provider` 与 `--model` 两个参数。

Worker launcher 不解析这些认证值，不引入 Coordinator CredentialStore 或 provider 端口。真实验收的环境选择应明确记录；未完成的目录查询返回 structured unavailable，允许用户手填 exact native ID，effort 保持 null。

Cline 的 Companion 首次与 resume 启动使用公开 `--tui --yolo`。安装版交互 CLI 显式选择 `backendMode: auto`，覆盖 SDK 的 `CLINE_SESSION_BACKEND_MODE`；yolo 模式才设置 `forceLocalBackend`。自动连接已有 hub 会丢失当前进程的 reporter 环境，并可能把工具执行移到只读边界之外。原生 yolo 对有限工具自动批准；只读角色仍用生产 bwrap，HOME/provider/auth 保持原环境，不改用户默认配置。该入口尚需真实验收。

Orca 曾以 `ProfileStateWriterError` 阻塞 terminal-create 和终端关闭。`next-cline3:planner:terminal-create` 返回 unknown，但旧测试脚本没有保存 request ID，现有记录不能完成对账；保留阻塞，不重跑该启动。随后独立 Kilo mini 尝试也在创建终端时返回 unknown，本次已保存回执，仍停止后续创建。Kimi 新 Planner 已退出原生 CLI，公开 terminal wait 确认 exited/0；最新完整 terminal-list 仅剩协调终端，Kimi 记录已不在列表中。旧关闭操作的回执仍未证实，不能改写成成功。

## 2026-10-12 续测

Orca 重启后的普通 shell terminal-create 成功，诊断终端已公开关闭。原 Run
`run_d394e13d9181` 经公开 run-use 绑定新协调终端
`term_fc9e2f9f-3ad7-4d49-9513-aab36e4f49b9`，consumer generation 为 2。
旧 Kilo planner unknown 未重放，request-show 仍为 absent；本轮运行的是独立的
finalizer 或 implementation 测试，未把旧 lane 改为成功。

| 本轮角色 | 真实结果 | 尚缺的资格证据 |
| --- | --- | --- |
| Kilo finalizer | terminal-create、就绪、worker-start 与提交均取得回执；Session 报告缺失。原生日志定位的精确 Session 经公开 export 核验 cwd，messages 为 0 | 模型轮次、报告与完整 Session Binding；日志定位不代替报告证明 |
| Cline finalizer | 驱动环境中的 provider 路径未传入 Orca terminal；原生界面进入登录并超时，绑定被拒绝 | 本次配置无效，不计目标模型验收 |
| Cline implementation | 将独立 provider 路径放入实际 launcher 命令后，进入 MiniMax 模型界面并生成精确报告；报告对应的原生 manifest/messages 未出现，绑定被拒绝 | 原生身份和消息、模型轮次、结果与完整覆盖 |
| Hermes finalizer | 通过就绪、精确 Session Binding、原生工具执行和 worker_done succeeded；Session 为 `20261012_201125_de271b`；完成 token 从公开 export 取得 | coverage 仍为 partial，实际模型证据为 null，不计完整资格通过 |

Cline 首次续测误把 `CLINE_PROVIDER_SETTINGS_PATH` 仅传给测试驱动；Orca 启动终端
使用自己的真实环境。Cline 启动会保存 provider/model 与 lastUsedProvider，本次因此在
原 `~/.cline/data/settings/providers.json` 新增无凭据的 `minimax-cn-coding-plan`
模型选择并改变最后使用项（更新时间 `2026-10-12T12:02:31.976Z`）。未写入新密钥，
原文件保留未回滚。修正后的 implementation 在命令前显式设置已批准的独立配置路径，
并核验原 provider 文件字节保持不变。测试驱动的环境不作为 Worker 环境证据。

Kilo mini 的固定版本输入、事件和 export 事实见
[源码调查](kilo-mini-input-20261012.md)。CR 提交、LF/补全及 bracketed paste 的处理
需要结合当前 Orca 实际注入验证；尚未取得真实注入字节，不把源码推断当作本机根因。
OpenViking 插件向只读配置目录写日志的 EROFS 已观察到，但尚不能证明它导致报告缺失。

本轮所有 mutation 的 operation/request、Task/Dispatch、角色结果、配置副作用和
清理观察保存于[续测证据](../../artifacts/next-worker-harness-adapters/continuation-20261012.json)。
已完成 Hermes 终端与普通诊断终端已关闭；Kilo/Cline 未结算尝试仍保留，不因缺少
轮次或超时自动停止、重派。本轮未新建 worktree，未注册新候选，未运行 mixed Controller。

类型、lint、build、OpenSpec strict 与 diff 检查通过。四家 adapter 与矩阵辅助测试
122 passed / 2 skipped。默认并行全量测试有一个 ledger-lab 用例在 5000ms 超时，
该用例单独复测通过；`pnpm exec vitest run --maxWorkers=4` 全量结果为
2507 passed / 18 skipped。独立最终 verification 未执行，任务仍为 7/12。

## 2026-10-12 输入与报告续查

实际测试包是 `/home/joshua/.nvm/versions/node/v24.12.0/lib/node_modules/@kilocode/cli`，版本 7.8.8，`kilo` 和 `kilocode` 都指向同一入口。此前界面差异来自启动参数 `--mini`。本轮默认完整 TUI 探针只移除该参数，沿用同一 launcher、模型、用户环境和报告器：Task `task_7a600e0eb80f`、Dispatch `ctx_354f0f437f96`、Session `ses_ecf98ec5affesgpu9oYvvS77w0`。公开就绪检查 satisfied/running，任务被接收并回复探针标记，worker_done succeeded；精确 Session Binding 和三条消息的完整覆盖通过，assistant 原生记录模型为 `minimax-cn-coding-plan/MiniMax-M3.1-Flash-Preview`。输入探针不计为完整角色验收。

报告缺失的已证明原因是原生配置覆盖：global config 依次合并 `config.json`、`kilo.json`、`kilo.jsonc`、`opencode.json`、`opencode.jsonc`，plugin 数组被后一个声明覆盖。本机 `opencode.json` 覆盖了原安装目标 `kilo.jsonc`。安装器选择最后声明 plugin 的配置，显式 `KILO_CONFIG_DIR` 按其原生顺序读取；保留其他插件与模型。独立安装后真实解析的插件数组包含 Companion reporter 的 file URI。

mini Validator Task `task_fea23fc4b8d0` 已通过工件、Session Binding、实际模型、完整覆盖和 worker_done。mini Implementation Task `task_18262f49e221` 完成工件与 worker_done，但原验收读取早于报告器最终 export，原失败记录保留。验收 helper 仅对同一 Kilo transcript 做最多 15 次、间隔 1 秒的覆盖复核，不重派、不重发、不放宽覆盖判定。

Cline 的独立 `--tui --yolo` 输入探针与新会话首次多行 Dispatch 都完成 worker_done；这证明直接入口能处理输入，未证明生产 launcher 的空任务根因，也不代替精确报告或完整矩阵。原 provider 文件核验不变。Hermes/Kimi 的导出和 hook 中客户端模型配置、请求模型或 alias 仍不作为 provider 响应模型证据。

本轮补充证据见[输入与报告记录](../../artifacts/next-worker-harness-adapters/input-reporting-20261012.json)。已结算的默认 TUI 探针与 mini Validator 终端公开关闭；未结算现场保留。任务仍为 7/12，新增生产注册 0。

恢复默认入口后，Kilo、报告器与矩阵辅助测试 76 passed / 2 skipped，typecheck、scoped ESLint、build、OpenSpec strict 和 diff 检查通过；全量测试未重复运行。

## 2026-10-12 默认 TUI 矩阵续测

当前 Orca `worker-start` 已提交 preamble，七家候选共用的 launcher 设为 `activation: 'none'`。原 helper 补 Enter 的 Kilo Planner 和 Validator 均未取得 Session 报告；仅省去额外 Enter 的 Kilo Implementation、Cline Validator 成功，构建完成后的默认 Kilo Validator 也通过。此改动消除重复输入，尚未解决全部启动交付问题；默认 Kilo 精确恢复和只读 Finalizer 仍未取得新轮次报告，后续 Planner 也未显示任务。各尝试拥有独立 Task/Dispatch，原失败记录不重写、不重发。

Cline Validator Task `task_9e6332b13c96`、Dispatch `ctx_f452547b015a`、Session `1791814275714_4auqg` 已通过原生 manifest/messages、精确 Session Binding、工件和 worker_done；coverage 仍为 partial，实际模型证据为 null。本机 `cline` 3.0.70 / `@cline` 0.0.92 的公开 npm 代码中，`core/dist/index.js` 的 `sj(agentConfig)` 用 `modelId/providerId/providerConfig.family` 构造 `messageModelInfo`，`agents/dist/index.js` 将它复制到 assistant `modelInfo`，因此是客户端配置。`metrics` 则从 provider usage 归一化、累计后取调用增量。`persistSessionMessages` 覆盖写入当前上下文消息；压缩和 checkpoint 恢复可裁剪，当前格式缺少可靠的全历史覆盖保证。

默认 Kilo Validator Task `task_563e73a62b0b`、Dispatch `ctx_084559fbdac7`、Session `ses_ecf88a937ffeN4xv5Qd6dPY65f` 已通过实际模型、完整覆盖和工件。精确 resume Dispatch `ctx_5ec18b3c01e5` 显示原会话历史，但新任务未进入对话、没有新的 launch 报告，续接未通过。只读 Finalizer Dispatch `ctx_bf4790e84daa` 没有报告；屏幕另观察到 OpenViking 插件向配置目录写日志/状态的 EROFS，插件源码捕获这些写入错误，尚不能把它判为输入丢失根因。拒写权限与原生插件配置保持。

独立只读 Finalizer 时序探针在同一 handle 的 tui-idle satisfied/running 后延后 65 秒，再执行一次 worker-start。Task `task_944475e67603`、Dispatch `ctx_4c412ecb90f2` 取得 input_accepted；报告定位 Session `ses_ecf7ecc31ffe7q1Yj0uAJ8awVz`，精确 export 的 messages 为 0。完整结算窗口结束仍为 ready/live，没有 worker_done，结果为 `worker_not_succeeded`。空 Session 不证明模型启动，延时对照不计生产通过，生产不加入固定等待。该终端与其他未结算现场保留。

公开协议续查：固定 submodule `cc5c85f` 的 [`isTerminalSendSettlementAgent`](../../references/orca/src/main/runtime/agent-prompt-submission-verification.ts#L54) 只包含 Antigravity/Claude/Codex；[`writeTerminalAgentPrompt`](../../references/orca/src/main/runtime/orca-runtime-write-terminal-agent-prompt.ts#L138) 对其他 harness 返回 unsupported/input_accepted。[`observeWorkerTurnStart`](../../references/orca/src/main/runtime/rpc/methods/orchestration/worker/worker-start-turn-observation.ts#L27) 不对 unsupported 开启轮次观测窗口。Kilo 的 [`TUI 配置`](../../references/orca/src/shared/tui-agent-config.ts#L202) 无 paste-ready 信号；[`tui-idle`](../../references/orca/src/main/runtime/tui-idle-evidence.ts#L157) 在无强 rest signal 时走 after-paint 安静判定。上述是源码快照事实，不冒充安装版实现核验。当前 1.4.222 的公开 `terminal send --help` 明确区分接收与轮次启动；失败 Dispatch 的 worker-show/read 仍为 input_accepted，agentWait 为 null。`--wait-submit` 要求原 text+Enter 请求，不能作为无输入查询；不对 worker-start 生成的未知文本重建或补发。现有公开信号与空 Session 都不足以证明实际任务进入模型，输入丢失根因仍未确定。

候选与 launch/matrix 测试 163 passed / 2 skipped；补充断言后 Kilo/Cline 29 passed；typecheck、scoped ESLint、build、OpenSpec strict 与 diff 通过。最新 `pnpm exec vitest run --maxWorkers=4` 全量 2510 passed / 18 skipped（212 文件通过、9 文件跳过），退出 0。详细角色结果、单变量对照、操作回执和保留现场见[默认 TUI 矩阵记录](../../artifacts/next-worker-harness-adapters/default-tui-matrix-20261012.json)。仍为 7/12 tasks，新生产注册 0；Recovery、mixed Controller 与独立最终 verification 未运行。

## 后续真实验收

2026-10-12 新 Antigravity Recovery Utility 已通过：Task `task_37c0eaa6859a`、Dispatch
`ctx_8b80837d560c`、Session `ad8a90c7-4b0b-441c-aa43-3f3c3efdcfef`，实际模型
`gemini-3.8-flash-medium`、coverage complete、Capsule 落盘回读、原上下文引用和
EROFS 拒写均成立。历史 RUNNING 快照仍被拒绝，没有放宽覆盖检查。已结算 Utility
终端公开关闭，receipt `405343c8-8a74-4432-9000-e527429a736f`，ptyKilled true。
独立 helper 的非消费 Delivery 快照不作为 Controller ack 验收。

新 Antigravity + Qwen Controller fixture 为 `/var/tmp/orca-ip04-mixed-controller-R6AahD`，
Scope `ip04-mixed-controller-485da76f-4ba2-4c13-941a-ff479dde1049`。已修复验收宿主
误继承主终端 Orca 身份环境的问题，同一 Scope 与原授权恢复成功。新 worktree
的原生信任菜单经显式确认消失，精确 prepared terminal 仍未取得公开
`tui-idle` satisfied/running 回执：10/15/30 秒等待、公开切换终端、隔离身份环境、
原生 Ctrl-L 重绘对照均超时；paneRuntimeId=-1、rendererGraphEpoch=0、agentWait=null。
缺少 renderer metadata 是观察事实，尚未证明是超时根因。Computer Use 因系统
python3-gi/AT-SPI 不可用而无法检查 GUI，未安装依赖。当前没有 Worker turn 在途，
测试进程已停止；原 prepared terminal、Scope、授权与创建回执保留，不能重新创建。
完整闭环、中断与重启尚未通过，仍不注册。现场和就绪复验条件见
[Controller 准备记录](../../artifacts/next-worker-harness-adapters/controller-preparation-20261012.json)。

本轮最终静态检查 typecheck、lint、build、OpenSpec strict 与 diff 通过；
`pnpm exec vitest run --maxWorkers=4` 为 2510 passed / 18 skipped（212 文件通过、
9 文件跳过）。这些检查不代替真实 Controller。当前任务为 9/12，新生产注册 0。

2026-10-13 独立限定审查发现并修复 Muse 的两个准入问题：未知或损坏的
retained record 不再被忽略后签发 complete；metadata/route facts 的 workspace
声明统一归一化并核验一致，冲突时身份、resume 和 Recovery 均不可证明。
已知 branch/model/reconfigure 记录保持可读，展开后的记录数同样有界。
5 个拒绝回归先复现失败，修复后 Muse 13 项、连同 reporting 16 项通过；独立
纯内存复核确认两个缺陷关闭。Muse 仍未真实验收，未注册。

Kimi 报告安装器同步修复 TOML hook 表头前的空行与缩进解析，安装状态、重复
安装和卸载现在沿同一正确表范围核验；字符串内的 `#` 不再被当成注释，
引号后非注释尾部仍拒绝，用户其他表、文件模式及原正文保留。Kimi 与 reporting
39 项相关测试通过，未改真实原生配置，也未改变缺少实际响应模型事实的延期结论。
独立复核还发现非法字段被跳过后可能追加 hook 并错误报告安装成功；现改为解析失败
直接拒绝安装/卸载，原文不变。该回归先复现失败，最终 Kimi/Muse/reporting 52 项通过。
审查及修复范围见[限定审计记录](../../artifacts/next-worker-harness-adapters/audit-20261013.json)。
最终加固后的全量回归为 2521 passed / 18 skipped（212 文件通过、9 文件跳过）；
typecheck、lint、build、strict 与 diff 通过。独立复核确认上述审查缺陷关闭。
Controller 就绪证明仍缺失，完整真实闭环与最终 verification 不计通过。

Kilo 默认完整 TUI 的新只读 Recovery 也未进入模型：源 coverage complete，Utility
Session `ses_ecf473907ffeGyKFEedQerK2Fi` 的公开 export 为 0 条消息，没有 worker_done。
结合 Planner、精确 resume、只读 Finalizer 和延时对照失败，当前延期。Cline/Hermes
缺完整历史覆盖与实际响应模型事实，Kimi 只保留请求 alias，分别延期；Muse/Cursor
等待原生 CLI 与登录。延期不是 PASS，均不注册。逐家尝试、阻塞及重验条件见
[探索记录](../../artifacts/next-worker-harness-adapters/exploration-20261012.json)。

Muse/Cursor 需要先安装官方 CLI 并完成原生订阅登录，再补四角色、精确 resume、Validator 同 Session 续接、Recovery、Orca foreground 接管、只读拒写及 mixed Controller/同 Scope 重启。Cursor 的编辑器 BYOK 文档不能证明 CLI 支持任意 MiniMax endpoint。

其他五家也只有同一完整矩阵和 mixed Controller 通过才注册。失败项保留 Task/Dispatch 与原生证据，不换 OperationId 重放未知 mutation，不以终端输出替 transcript。测试串行并复用隔离 fixture；已结束的测试终端及时关闭，当前测试需要的协调终端保留。不创建本仓库额外 worktree，不改上游或 ledger-lab。
