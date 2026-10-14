# 新一批 Worker Harness 接入

对应 change：`add-next-worker-harness-adapters`。本页记录本轮资格；前驱的候选调查与 PASS 保留原验证范围。

六家候选的 2026-10-14 续探见
[续探记录](next-worker-harness-continuation-20261014.md)：包括旧资源精确回收、
Kilo 新 Run 的 prepared 派发失败、Kimi 基础两角色的 agent-trust-workspace 阻塞，
以及其余候选的公开能力核验。准入已改为显式登记与分级支持（change
`grade-worker-harness-admission`）：登记表含全部 14 家已实现 adapter（codex、claude、
opencode、pi、omp、command-code、qwen-code、antigravity、kilo、kimi、hermes、
cline、muse、cursor），等级由 `src/domain/worker-harness-support.ts` 从
`src/adapters/agents/worker-harness-qualifications.ts` 的证据推导。当前等级：
complete = command-code、qwen-code、antigravity；enhanced = codex；basic = claude、
opencode、pi、omp、kilo；kimi、hermes、cline、muse、cursor 未达 basic。2026-10-14
以 Command Code 独立验证基础路径（隔离现场 `/var/tmp/orca-harness-acceptance-uUxIxc`，
Planner/Implementation 均 ran/succeeded、工件核验通过、原生字段全为 null，55 passed /
2 skipped，[证据](../../artifacts/next-worker-harness-adapters/ip04-2026-10-14T10-55-18-402Z-43432fa6-df72-4e03-b63f-5cb3f5fe6d1d.json)）；
Kimi 的基础真实运行在 prepared 阶段被 `agent-trust-workspace` 阻塞（两个角色均
`prepare_failed`、无 Task 启动，现场 `/var/tmp/orca-harness-acceptance-ehbi1C`，
[证据](../../artifacts/next-worker-harness-adapters/ip04-2026-10-14T10-54-18-998Z-5e735251-9a5b-40fa-8d19-00ab562e274e.json)）。
Recovery Utility 与历史恢复只开放 complete 级。下文带日期的轮次记录保留当轮结论；
「未注册」不再表示当前可用性。

只读是任务级可选能力，不参与等级推导：只有实际需要只读的操作（Recovery Utility、只读 Graph Patch/纯分析、按旧授权 policy 的只读 Finalizer）在派发前核验只读能力组与真实拒写探针；普通 Validator 与可写 Finalizer 不因缺少只读证据被拒绝。

Kilo 的 basic 使用 10 月 14 日 Planner 成功与 10 月 12 日默认 TUI Implementation
成功的可核验记录；后续缺少报告不撤销已核验事实。当前输入或信任检查失败仍阻塞该次
操作，高级角色、续接及历史恢复尚未取得所需证据。

基线 HEAD 为 `13b203f62bbb68a60456c5acd7d28e4c54c625a4`，直接前驱已归档。早期候选矩阵使用 Orca CLI/runtime 1.4.222；Antigravity 当前完整闭环使用未修改的 1.4.224。Ubuntu 使用 `orca-ide`。submodule 固定 `cc5c85fb7a43ed52c6cd29157210020cd769d84c`；七个新候选均有上游 builtin identity。

## 原生事实与当前验收

2026-10-13 用户明确禁止 patch Orca，接入只适配未修改的公开 CLI/runtime。此前独立
源码副本的补丁与测试仅保留为诊断证据，停止匹配新版源码、构建或应用修复版的路线。
该轮完成 12/12 tasks 并注册 Antigravity；其余候选的当前等级与阻塞见上文。
第二轮 mixed Controller、最终集成回归与限定审计通过；独立
[verification](../../openspec/changes/add-next-worker-harness-adapters/verification.md) 结论 PASS。
较早失败轮次的 prepared 资源、Scope 与未决操作继续保留。

本次核验原生文档、公开 CLI、启动调用链，并在本项目运行独立只读输入探针：

- `agy` 未列出关闭周期协议重申的公开选项；列出 `--print`、`--input-format stream-json`
  和 `--output-format stream-json`。`TERM=dumb` 对照仍有约 2 秒周期输出。
  原生 stream 模式已通过只读拒写、hook/精确 Session、exact resume 与同进程两轮上下文
  探针；在本项目 launcher 内加入单轮输入转换后，公开就绪、监督接管和结算也已通过。
  完整 stream 矩阵随后失败于 `composer_not_shown`/`agent_readiness`，print 会话的
  工作区来源也不能在替换原生缓存后稳定复核；该路径不作为接入方案。
- Orca 公开支持 `worker-start --agent antigravity --model ID`，本项目已有
  `orca_managed` strategy。该命令没有逐次 launcher command/env 或精确 conversation
  参数入口，现有 reporter 与 bwrap 包装不能直接搬过去；也未证明 Orca 内部启动会
  避开同一静默门槛。不能把它当作已可用替代方案或等级证据。
- prepared 路径仍只接受原 handle 的 `tui-idle` satisfied/running；`terminal wait`
  仅公开 exit/tui-idle，没有静默阈值参数。`activation` 在就绪之后执行，改成
  `submit_draft` 不解决当前超时，也不能追加 Enter 试探未知输入。

具体输入协议、官方来源与本机结果见[原生输入调查](antigravity-native-input-20261013.md)，
脱敏回执汇总见[stream 桥接证据](../../artifacts/next-worker-harness-adapters/antigravity-stream-bridge-20261013.json)。
当前候选实现保留原生 TUI，在本项目 launcher 内用系统 `script` 提供真实 PTY，
以有界字节解析器仅去重三种完整的重复输入协议设置。stdin 原样继承；其他输出、
未知或截断控制序列原样转发，控制字符串内不滤内容。25ms 内不能完成的片段转发后
停止本进程过滤。该选择封闭于 Antigravity/Linux/TTY，复用原 bwrap/seccomp，
Orca 仍拥有 preamble 提交、公开就绪和监督生命周期。身份核验增加按完整 ID 只读
查询 Antigravity 自己的 `conversation_summaries.db`；已配对的工具 `GENERIC/ERROR`
作为工具终态，RUNNING 与未知状态仍拒绝完整覆盖。合同见 IC-07 与 design D-05。

临时 TUI 原型已取得真实就绪、监督结算、精确 Session 与完整覆盖，见
[TUI 过滤证据](../../artifacts/next-worker-harness-adapters/antigravity-tui-filter-20261013.json)。
2026-10-14 沿 `/var/tmp/orca-harness-acceptance-fndTfZ` 原 Run、四个 ready Task 与
终端续接，确认隔离仓库的原生信任菜单后，四个原句柄均返回公开 `tui-idle`
satisfied/running。完整角色与恢复已通过；第一轮 mixed Controller 阻塞于 Qwen 启动，
第二轮闭环通过后注册 Antigravity。
原 Controller 现场保留，不替换其已接受的 prepared 资源。

2026-10-14 原矩阵续接已通过四角色、Implementation 精确 resume 与 Validator 同
Session 上下文续接，模型均为 gemini-3.8-flash-medium，覆盖 complete，见
[矩阵证据](../../artifacts/next-worker-harness-adapters/ip04-2026-10-14T02-15-07-641Z-5cf6ca74-2bd4-450d-b9de-dcfc280266b6.json)。
首轮 Recovery Utility 监督结算 succeeded；额外只读诊断证明 Capsule schema、原事件引用
与 EROFS 拒写有效，但两个后台搜索的启动记录持续为 RUNNING，后续取消通知为
SYSTEM_MESSAGE 正文，对应日志为空。当前完整覆盖判定仍拒绝，Recovery 不计通过。
见[后台事件诊断](../../artifacts/next-worker-harness-adapters/antigravity-recovery-background-20261014.json)。
旧派发保留为失败证据。有界前台读取配方在独立对照中通过完整覆盖与 EROFS；
随后修复矩阵夹具的最终响应竞态：沿精确 transcript 等待 Validator 最终 assistant
标记后才确定 Recovery 范围。新 Validator→Recovery→原 Session 续接链全部通过，
覆盖 complete、sourceBehaviorVerified/readOnlyVerified 为 true，见
[新链证据](../../artifacts/next-worker-harness-adapters/ip04-2026-10-14T02-42-26-090Z-425d6eb9-bcb6-44a2-903e-6f57e500e3fc.json)
与[资格汇总](../../artifacts/next-worker-harness-adapters/antigravity-tui-qualification-20261014.json)。
生产覆盖判定未放宽；后台 RUNNING 仍拒绝。

mixed Controller 使用隔离 fixture `/var/tmp/orca-ip04-mixed-controller-ardK9O`，
Scope `ip04-mixed-controller-f7c116b9-3be3-42b9-aedd-08246186e9b2`、Run
`run_f00be143e685`。原 prepared 信任菜单确认后公开就绪通过，Planner 与 Implementation
结果均已接纳。Qwen Validator `ctx_42e946fccf7c` 已派发并激活，但原生启动出现
Built-in Provider Updates 菜单，选中 Remind me later 后回到空输入框；精确 Session
只有 runtime sidecar，没有 transcript，Companion 报告为空，绑定窗口到期。
启动/激活 Intent 均已结算 accepted，Orca exactWorker/live；这些事实不能证明模型
轮次已开始，也不能确定菜单吞输入的具体机制。Qwen 原生自行更新 0.25.0→0.25.1，
当前在途进程仍为 0.25.0；Companion 没有请求更新。
测试宿主准确停止，原 Worker/Task/授权/终端保留，不追加 Enter 或重发未知输入。
证据见[Qwen 启动记录](../../artifacts/next-worker-harness-adapters/controller-qwen-startup-20261014.json)。
Qwen Validator 中断/Recovery、集成、Finalizer 与同 Scope 重启仍待验证。
注册前全量回归 2547 passed / 18 skipped，types/lint/build/strict/diff 通过；
注册后的最终检查另行记录。

官方 0.25.0 发布 bundle 的 `useProviderUpdates` 在 UI mount 时无条件检查更新，
存在请求时由 `ProviderUpdatePrompt` 独占渲染。没有找到公开 CLI/env 单次关闭开关。
`later` 在原生 providerMetadata 中保存 postponedVersion/postponedAt，冷却 24 小时；
`skip` 保存 ignoredVersion，`update` 会应用 provider 配置更新。CLI 自身自动更新
另由 [general.enableAutoUpdate](https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/settings.md)
控制，没有找到单次进程开关。Companion 不写这些用户设置，也不使用会禁用 hooks
与配置发现的 bare/safe 模式。

第二轮只读对照核验 managed npm 的 0.25.1 发布包：provider update hook、
24 小时冷却与独占菜单逻辑和 0.25.0 相同，没有找到该菜单的公开单进程关闭入口。
来源为 `versions/0.25.1/node_modules/@qwen-code/qwen-code/chunks/chunk-XFCR3IPL.js`
中的 `findAllPendingUpdates` / `useProviderUpdates`，以及
`startInteractiveUI-PNJZF35R.js` 的菜单渲染分支。CLI 自动更新的
`QWEN_CODE_SKIP_UPDATE_CHECK_ONCE` 是内部 relaunch 所用环境键，不作为公开适配合同。
官方设置文档把 provider 提示和自动更新联系起来，但 0.25.1 的 provider hook 没有
`general.enableAutoUpdate` 门控；关闭该设置不能据此声称已消除菜单。
managed npm 包与全局入口版本可能不同，实际 Worker 所用版本仍须从启动事实核验。

原轮保留，已用现有 fixture 脚本准备一次独立对照
`/var/tmp/orca-ip04-mixed-controller-wbaa9R`，继续同样的 Antigravity/Qwen 角色矩阵。
它使用当前原生环境，新启动 Qwen 的实际版本与 Session 必须重新核验；不将原生
更新完成或菜单延后当作启动问题已解决，也不改写原 Scope 的失败记录。
第二轮 Scope `ip04-mixed-controller-33ba70e3-434f-4925-8c91-20003d91e78e`、Run
`run_ca667d0144a9` 已授权。原 prepared
`term_6ae8ca97-383b-4d68-9457-28380bc19150` 在准确隔离仓库信任确认后取得
公开 `tui-idle satisfied/running`，Controller 自动派发 Planner
`task_461d5d534d35` / `ctx_84d14da5e898`，精确原生 Session
`49a10338-304d-47a8-bf82-74a7fe156d5c` 已绑定并接纳。Implementation
`task_27cf3ac4ae16` / `ctx_40329b05739c`（Session
`207d9cc5-88ef-4586-bfe7-4badaea68afd`）同样已接纳。
Qwen Validator `task_8726472ed888` / `ctx_7ebb460dbe30` 的精确 runtime sidecar
核验实际版本 0.25.1、Session `7f6bb0e2-b52a-4ea3-86f1-13357be2e914`。
本轮 user/assistant 历史可读后按计划中断，公开 exactWorker/exited 已证明。
Recovery Utility `task_ed4dc5bceb35` / `ctx_03905bd3ef22` 的 Capsule 被 Controller
接纳；替代 Validator `ctx_3521b1ac0138` / Session
`143c0e75-29a9-4006-8640-2a16610a0d1f` 仍在原 Task/Attempt，恢复预算消耗 1。
Validator passed 后完成 Git 集成与私有 origin 推送，Finalizer
`task_1f674a021d46` / `ctx_82bf4dbff628` 给出 deliverable。同 Scope 重启保持
5 个 binding、1 次 Recovery、4 项结算与已消耗预算；真实测试 1 passed、退出 0。
见[完整闭环证据](../../artifacts/next-worker-harness-adapters/controller-20261014T033336705Z-09c8d325-3fc7-4e49-bcd9-aebad90db5e1.json)。
本轮已结算的 5 个外部 prepared 终端、专用协调 shell 与空闲 worktree shell
均按精确句柄公开关闭；fixture/worktree 文件保留供独立验证，旧失败轮次不动。
见[回收回执](../../artifacts/next-worker-harness-adapters/controller-cleanup-20261014.json)。
这证明本轮闭环，不证明 provider 更新菜单以后不会再出现。

注册后的 `pnpm typecheck`、`pnpm lint`、`pnpm build` 全部通过；全量
`pnpm exec vitest run --maxWorkers=4` 为 2551 passed / 18 skipped，213 文件通过、
9 文件跳过。通用生产只读探针不覆盖 executable，实测 available/host-verify；
此时 `agy` 已自报 1.3.5，本机可执行文件的替换时间为 03:40 UTC，在本轮 Controller
03:33 UTC 结束之后。1.3.5 探针只证明该版本的生产包装器与版本入口，不替代
记录为 1.3.4 的完整角色资格。见[注册检查](../../artifacts/next-worker-harness-adapters/antigravity-registration-validation-20261014.json)。

注册链路审计发现 doctor 绕过所属 adapter 的目录查询，误报 Antigravity 目录不可用；
现已统一经注册 harness 的 `queryModels`，复用 adapter 自己的 `agy models` 实现。
doctor 可观察结果回归通过，Worker 检查不读取 Coordinator 凭据；上述全量结果包含此修复。
独立限定审计结论为 no findings，另行执行125项相关回归，doctor 的 P2 已复核关闭；
见[审计证据](../../artifacts/next-worker-harness-adapters/audit-20261014.json)。

### 2026-10-13 原生 stream 与公开监督对照

`--print=` 与 `--input-format stream-json --output-format stream-json` 组合可以等待输入，
没有周期 ANSI 重申；裸 `--print` 会吞掉后续 flag。只读探针读取哨兵成功、OS 拒绝
追加写入且原文不变。`--conversation` 恢复精确 ID 后，同进程两轮保持 nonce 和原
哨兵上下文；报告、native metadata 和完整 transcript 交叉核验通过。usage 是会话
累计值，不能把逐轮累计量相加。

公开对照区分了就绪与识别：外层 Node bridge 的 stdout 转发和继承两种形式都取得
`tui-idle satisfied/running`，但 `worker-start` 返回 `agent_unconfigured`。去掉 bridge
的原生 launcher 通过识别并建立真实 Worker，随后 `process_exited`/exit 1，调用返回
`dispatch_inactive`；它已有副作用，不能当作未派发或换 OperationId 重试。具体原生
输入错误未捕获，不能仅从退出推断。

把同一输入转换合入临时 launcher、移除外层 Node 进程后，真实 `agy` 通过公开
`tui-idle` 与 `worker-start`。该命令只证明 `input_accepted`，turnStart 为 unsupported；
后续 native `SUCCESS`、精确 Session `97e98418-f9a5-4565-b229-d26d14748bad`、
完整 `step:0–7` 以及 Orca 的 succeeded/completed 才证明任务确实执行。
87 行 preamble 只转换提交一次，保留 marker 和 `中文🌊`，读取 `package.json` 得到
`orca-companion`。唯一 `worker_done` 匹配 Run/Task/Dispatch/终端后保存并整批 ack。
输出保持 native stdout/stderr，未伪造标题、hook 或身份，Orca 与生产注册表不变。

安装 bundle 的只读检查定位了 foreground-agent 识别门，但未证明外层 bridge 失败的
具体分类规则；不能把进程层数、stdin pipe 或某个文件名写成稳定兼容合同。这个
单轮原型没有生产级 result 驱动、连续回复、取消和 EOF 管理，也没有 Controller 资格。

| 候选 | 版本依据 | 精确会话路径 | 本轮真实结果 |
| --- | --- | --- | --- |
| Antigravity | 独立矩阵 1.3.3；当前注册 1.3.4 | hook conversation ID，精确 cache/history 或 native summary 工作区来源与 `brain/<ID>/.system_generated/logs/transcript_full.jsonl` 交叉核验；`--conversation ID` | 1.3.4 TUI 四角色、Implementation resume、Validator 同 Session 续接与只读 Recovery 通过；mixed Controller deliverable、人工中断/Recovery、集成及同 Scope 重启通过，已注册。 |
| Kilo | `@kilocode/cli` 7.8.8；源码 tag [e2887f0](https://github.com/Kilo-Org/kilocode/tree/e2887f08e5a6394299c810ba508f358aaf4c5bc3) | 原生 session plugin；`kilo export ID --pure` 独立核验 ID/cwd；`--session ID` | 默认完整 TUI 的 Implementation、Validator 与输入探针通过；Planner、精确 resume、只读 Finalizer/Recovery 无可靠模型轮次。延时对照仍为空 Session，延期，未注册。 |
| Kimi | `kimi --version` 2.1.1 | 原生 SessionStart；确定的 cwd 分区路径与 exact-ID ZIP export 交叉核验 manifest/wire | Planner 的精确绑定、工件、worker_done 与覆盖通过；usage.model 只保留请求 alias，缺实际响应模型事实。2026-10-14 基础两角色在 prepared 阶段被 `agent-trust-workspace` 阻塞（现场 `/var/tmp/orca-harness-acceptance-ehbi1C`，[证据](../../artifacts/next-worker-harness-adapters/ip04-2026-10-14T10-54-18-998Z-5e735251-9a5b-40fa-8d19-00ab562e274e.json)），当前 unavailable。 |
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

2026-10-13 续接时，Orca 1.4.224 对原 prepared 与协调终端均返回
`terminal_handle_stale`；两个精确 worktree 的公开终端列举均为空，未截断、未遗漏 host。
公开 `open` 显示已有桌面后复查仍为空。原 worktree 保持未归档，原 Run 保持
consumer generation 1 与原 coordinator handle，Planner Task 仍为 ready，Worker 列表为 0。
这些事实不能证明原进程退出或终端已删除，也不能解释先前的就绪超时。
已请求用户在 GUI 恢复/显示已有 fixture 终端；未新建资源、改写 handle 或重跑 Controller。
恢复须先证明原资源身份，再取得 exact `tui-idle` satisfied/running 回执；运行时句柄变化
还需受支持的身份对账，不能按标题匹配替换原创建记录。现有 Antigravity 与 Worker launch
回归 20 项通过；任务仍为 9/12，新生产注册 0。公共回执及现场见
[续接核验记录](../../artifacts/next-worker-harness-adapters/controller-recovery-20261013.json)。

用户随后确认 GUI 可见终端输入区。复查出现新 handle `term_ebc00c49-0459-4dbc-933d-eed079421bd9`，
incarnation 与原回执不同；Orca 标记 orphaned，列举遗漏 local host，paneRuntimeId=-1、
agentWait=null。stream 含 Antigravity banner 后的 shell 提示符，原 handle 仍失效，
新 handle 的 10 秒 `tui-idle` 核验超时。GUI 可见尚不能证明原 launch 连续性。
用户已批准保留原现场、另建独立 fixture 继续完整闭环；新验收与原 Scope/launch 身份独立，
不改写原创建记录，也不将新现场作为原 launch 恢复证明。

新隔离 fixture `/var/tmp/orca-ip04-mixed-controller-lO3X04` 已建立 Scope
`ip04-mixed-controller-19b0fa54-f5ad-4863-b9e1-c79ea68f7948`、授权和 Run
`run_c3cd0d92fa1a`。共享 `toChildEnvironment` 现同时过滤父 structured agent session
身份，修复真实调用中的 `consumer_fenced`；既有 doctor 环境回归已扩展，相关 44 项和
全量 2521 项通过。首次 Run 创建在发请求前明确 rejected，随后经现有应用用例补齐
同一新 Scope，再使用既有 rejected-intent 重试路径；没有重放 unknown 或已接受创建。

当前 Orca 1.4.224 / Antigravity 1.3.4 的 prepared handle
`term_85db0d8d-6276-40af-9f1f-217301b078ed` 保持原 incarnation，connected/writable、
非 orphaned，paneRuntimeId=1、rendererGraphEpoch=1。确认 trust 后，公开 screen
底部四行匹配 composer 规则；固定源码与安装包中的该规则均要求 3 秒输出静默。
stream cursor 53 未新增文本行，但八次公开 `lastOutputAt` 采样均距最近输出不足 2 秒，
停止 Controller 后仍继续前移。周期性非文本输出打断静默条件是当前主要解释；公开接口
不暴露原始输出、可信网格是否被接受或内部 verdict，因此不将解释写成已证根因。
切换、一次 Ctrl-L 重绘和 10/15/30 秒等待均未取得 satisfied/running。

已核验 PID/cwd 并 SIGINT 停止本轮 Vitest 父进程，父子测试进程均退出；原生终端保留。
Run 只有一个 ready Planner Task，Worker 数为 0，人工中断、Recovery、集成、deliverable
和同 Scope 重启未通过。恢复只沿本轮 Scope/Run/Task/授权与原 prepared 创建资源，
先取得 exact `tui-idle` satisfied/running；不重跑一次性 seed 脚本、不新建替代终端，
不降低静默/身份标准。脱敏回执、输出时钟采样与现场见
[新现场就绪记录](../../artifacts/next-worker-harness-adapters/controller-readiness-20261013.json)。

继续调查在同一隔离 worktree 新开了独立、无模型任务的原生诊断终端，以系统 `script`
记录原始 PTY 输出与时序，35 秒后自动结束并公开关闭。原 prepared 进程的 `strace`
附加被系统 ptrace 策略拒绝，未修改系统权限；原终端、Scope、Run 与 Task 保留。
原生诊断的 20 个输出块中，有 16 个完整且相同的 22 字节块：
`ESC[?2004h ESC[>4;2m ESC[=1;1u`（实际无中间空格），即括号粘贴、modifyOtherKeys
与 kitty 键盘协议设置。重复间隔为 1.9998～2.0172 秒，不新增文本行。最后一次其他
输出在 5.6255 秒，其后直到 33.6410 秒仅有这些协议重申。

固定源码与安装包均在 `onPtyData` 收到任意块时、规范化前更新 `lastOutputAt`；
Antigravity composer 规则又要求该时钟静默 3 秒。离线回放在 2 秒轮询点从未满足原
静默条件；仅排除已捕获的完整协议块后，从第 10 秒轮询起可以满足。该原生机制已
独立复现，足以解释此前的空输入框、文本 cursor 不变与输出时钟持续前移。
诊断没有使用 Companion launcher，原进程无法直接追踪，可信网格内部 verdict 仍
不可见，因此不能声称原现场的全部原因已排除；回放也不计为真实就绪或 Controller PASS。

此前探索的上游修复方案（现已停止）保留原始字节、协议处理和原始输出时钟，仅让就绪静默
计时区别处理已完整识别的重复输入协议设置。沿用 3 秒阈值、可信 composer 和运行中/
菜单/弹窗 veto；正文、清屏、屏幕切换、标题、未知与混合输出仍算活动，分块未完成
时不得建立 ready。现有 escape scanner 能携带分块 CSI，但跳过 OSC 和未知 ESC，
不能仅按 `onText` 为空来实现该分类；解析状态须有界，并按 PTY incarnation 重置。
该上游方案已停止；当前 Companion 侧有界过滤只作用于已识别的重复输入协议，
仍须取得公开就绪回执。上游与安装版未修改，具体回执、
捕获时序、回放边界及修复验证清单见
[协议输出诊断](../../artifacts/next-worker-harness-adapters/tui-idle-protocol-output-20261013.json)。

用户已批准在 `/var/tmp/orca-tui-idle-fix-20261013-lDj0mK` 的固定 SHA 副本实现修复。
活动状态由 PTY record 拥有，现有 escape scanner 补齐非 CSI、未完成状态、通用 ESC/CSI
与 C1 观测；超长未完成序列只保留有界未知前缀，OSC 与其他控制字符串分别按 BEL/ST
规则结束。完整且重复的三个输入协议设置不推进活动时钟；模式变化、正文、未知或混合
输出继续计时。incarnation 替换、输出缺口和已确认退出清除状态，普通重连保留状态。

活动时钟只供已有强输入框规则使用。弱标题和前台进程仍按 raw 时钟判断；投递重检
定时器也保留原调度周期，其回调重新读取修复后的证据。直接改定时器为已静默的活动
时钟，会在屏幕或 working veto 持续存在时引入多余的 50ms 重检，故没有这项改动。
raw 字节、PTY/leaf 输出时钟与 3 秒阈值均保持不变。

实际 `onPtyData`、incarnation 与 gap 方法的三项回归在原源码副本均失败，在修复副本
通过；强 composer 与缺可信屏幕的 PTY/leaf 轮询分别接受、拒绝。限定运行 11 文件、
279 项通过（276 个不同场景；临时捕获测试复用了三项 ingestion 场景），核心 parser/
activity 严格类型检查通过。20 块原生输出经 ingestion 回放，原门槛在所有采样轮询点
都未就绪，修复后从第 12 秒轮询起就绪；其他输出会清除协议证明，第 7.541604 秒的
首次重申仍算活动，因此比早先仅过滤完整块的诊断回放晚一轮。屏幕使用固定可信
composer，未加载完整终端模型，不计为 public wait 或 Controller PASS。

[补丁](../../artifacts/next-worker-harness-adapters/orca-tui-idle-activity-20261013.patch)
覆盖 13 个上游文件，已在原 submodule 上通过只读 `git apply --check`，没有实际应用。
完整上游 runtime 测试、类型检查与 build 因未安装依赖而未完成；复用的是主项目
Vitest 5.0.1，源码声明为 5.0.3。副本 package 为 1.4.214，安装版为 1.4.224；
该补丁路线已按用户约束停止，不继续匹配或构建修复版。当前仍 9/12、新增生产注册 0。
具体命令、限制及原现场恢复条件见
[修复验证证据](../../artifacts/next-worker-harness-adapters/tui-idle-repair-20261013.json)。

Kilo 默认完整 TUI 的新只读 Recovery 也未进入模型：源 coverage complete，Utility
Session `ses_ecf473907ffeGyKFEedQerK2Fi` 的公开 export 为 0 条消息，没有 worker_done。
结合 Planner、精确 resume、只读 Finalizer 和延时对照失败，当前延期。Cline/Hermes
缺完整历史覆盖与实际响应模型事实，Kimi 只保留请求 alias，分别延期；Muse/Cursor
等待原生 CLI 与登录。延期不是 PASS，均不注册。逐家尝试、阻塞及重验条件见
[探索记录](../../artifacts/next-worker-harness-adapters/exploration-20261012.json)。

Muse/Cursor 需要先安装官方 CLI 并完成原生订阅登录，再补四角色、精确 resume、Validator 同 Session 续接、Recovery、Orca foreground 接管、只读拒写及 mixed Controller/同 Scope 重启。Cursor 的编辑器 BYOK 文档不能证明 CLI 支持任意 MiniMax endpoint。

其他五家也只有同一完整矩阵和 mixed Controller 通过才注册。失败项保留 Task/Dispatch 与原生证据，不换 OperationId 重放未知 mutation，不以终端输出替 transcript。测试串行并复用隔离 fixture；已结束的测试终端及时关闭，当前测试需要的协调终端保留。不创建本仓库额外 worktree，不改上游或 ledger-lab。
