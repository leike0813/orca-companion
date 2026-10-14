# 未注册 Worker Harness 续探（2026-10-14）

本轮承接 [handoff](../../openspec/changes/add-next-worker-harness-adapters/handoff.md)，
核验六家延期候选并重开 Kilo 的隔离输入对照。六家继续保持未注册；原 change 的
12/12 与 verification PASS 不代表这些候选通过真实资格，本轮也未归档或提交。

## 运行基线与资源回收

当前未修改的 Orca 为 1.4.224，runtime
`9504f185-ea15-49a0-bdf1-909bde15d5f2`。本机 Kilo 7.8.8、Kimi 2.1.1、
Cline 3.0.70；Hermes banner 为 0.17.0，实际 checkout 仍是
`e20ff352b91623d51ae05ea586a1800aee852402`。Hermes banner 同时显示另一个
upstream 短 SHA，不能据此认为安装源码已经升级。Muse、cursor-agent 不在 PATH。

仅查询由已有本任务证据定位的 10 个 fixture 项目、14 个工作区；公开 terminal
inventory 全为空，但多数历史 Worker liveness 是 `unverifiable/missing_status`。
Kilo 旧 Recovery、resume 与协调 handle 均返回 `terminal_handle_stale`。没有重建
这些终端，也没有重放旧 Kilo/Cline unknown 创建。

已通过 Controller 的 `wbaa9R` 工作区有确定关闭回执、干净工作树和已集成 main
的提交，因此归档后用公开 `worktree rm` 删除其 Worker worktree，再用
`project setup-delete` 解除该 fixture 的 Orca 登记。回读确认仅 main 曾留下，
之后 repo list 已无该登记；main、私有 origin 和其他失败现场文件仍保留。
归档位于 `/var/tmp/orca-harness-evidence/wbaa9R-successful-{worker,fixture}-20261014.tar.gz`。
详见 [清理记录](../../artifacts/next-worker-harness-adapters/cleanup-continuation-20261014.json)。

## Kilo：输入交付与只读启动分别调查

新隔离 fixture：`/var/tmp/orca-harness-acceptance-kO5qmi`；Run
`run_69d30cfe1205`。使用既有批准模型
`minimax-cn-coding-plan/MiniMax-M3.1-Flash-Preview`，effort 为 null。
未移除插件、修改原生默认配置、放宽 bwrap/seccomp 或修改 Orca。

真实入口选择 `implementation,finalizer`，共运行约 397 秒：两者都经过 prepared
就绪和接管，公开 Worker 记录停在 `input_accepted`，180 秒绑定窗口内没有
Session 报告。原生 screen 仍为空 composer；Implementation resume 因原 Session
不可证明而拒绝。两项真实资格断言失败，其余本轮入口断言 48 passed、2 skipped。
原始证据是
[ip04 JSON](../../artifacts/next-worker-harness-adapters/ip04-2026-10-14T06-53-29-655Z-2b47ed3a-13be-4de2-8dba-38aecef7363b.json)。

随后另建独立诊断终端，保持同一 launcher、原生插件与模型，每个输入只提交一次：

| 路径 | 已直接观察的结果 | 范围 |
| --- | --- | --- |
| 可写原生 `--prompt` 短提示 | 精确 Session 与最终 assistant 答复成立 | 原生输入探针 |
| 同 Session 公开 terminal send 短提示 | 精确 export 中新增用户消息及最终答复 | 原生续轮 |
| 同 Session 5 行提示 | 完整多行用户消息及最终答复成立 | 多行交付 |
| 同 Session 26 行、约 2.3 KiB 提示 | 长提示及最终答复成立 | 跨 paste summary 阈值 |
| 新冷启动，公开就绪后首次短提示 | 新精确 Session 与最终答复成立 | 首次交付 |
| 首次只读原生 `--prompt` | 精确报告存在，公开 export 仍为 0 消息，伴随插件 EROFS | 尚未证明模型轮次 |
| 同只读提示加 `KILO_NO_DAEMON=1` | 新精确报告存在，公开 export 同样 0 消息与 EROFS | 单独禁用 daemon 未解阻塞 |

可写长提示通过，说明本轮不能将“多行/长度本身”认定为 prepared 派发失败原因。
`terminal send --wait-submit 10` 的成功对照仍只返回
`input_accepted/provider=unsupported`；实际答复由精确原生 export 证明。
原生 `--prompt` 的成功不替代 prepared 派发、角色工件、resume 或 Controller。
只读 EROFS 与空 Session 同时出现，尚不证明插件是根因。
相同只读提示的独立 no-daemon 对照也没有消息，不能把 daemon 当作已证根因。

源码对照固定在 [Kilo commit e2887f08](https://github.com/Kilo-Org/kilocode/tree/e2887f08e5a6394299c810ba508f358aaf4c5bc3)：
[TUI entry](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/opencode/src/cli/cmd/tui.ts)
保留 `--prompt` 并可连接 daemon；
[prompt](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/tui/src/component/prompt/index.tsx)
在 5 行或 800 字符以上折叠粘贴，原生 submit 有双重 deferred 调用。
该 commit 来自既有 7.8.8 调查的固定源码；本轮未证明安装二进制与其逐字对应。

下一步仍需分别取得 prepared 输入的实际交付证据、首次只读轮次和 exact resume。
只有这三条路径可靠后，再补完整四角色、Validator 续接、Recovery 与 mixed
Controller。新增探针及精确身份汇总见
[输入对照](../../artifacts/next-worker-harness-adapters/kilo-input-continuation-20261014.json)。
两个已完成可写输入对照的终端按原 incarnation 公开关闭，回执均为 ptyKilled。
本轮两个未结 prepared Worker、协调终端及两个空 Session 的只读诊断终端保留，
不能将测试进程结束、空 transcript 或插件错误当作 Worker 退出证明。

## Kimi：请求侧 model 不是响应侧身份

本机 executable 实际来自 npm `@moonshot-ai/kimi-code`，不是早期 Python
`kimi-cli` 的同名版本。官方 2.1.1 tag 对应
`f67e6398fb3210ad8ace970e2dfd5bcc984ed61f`。

直接源码表明
[llm.request](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/packages/agent-core-v2/src/agent/llmRequester/llmRequestOps.ts)
有 `model` 与可选 `modelAlias`，但它是请求事件；
[usage plugin](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/packages/agent-core-v2/src/human/usage/plugin.ts)
从创建插件时传入的 `input.model` 写 usage model。不能把字段名 `model` 当作
provider response 身份。本轮没有继续追插件构造调用点，也未发现可用于本机
精确 Session 的响应侧替代来源，保持延期。交接中 alias 来源的更细判断仍属原证据。

## Hermes：安装版导出明确排除 inactive

直接读取安装 checkout：
[get_messages](https://github.com/NousResearch/hermes-agent/blob/e20ff352b91623d51ae05ea586a1800aee852402/hermes_state.py#L3136)
默认 `include_inactive=False`，SQL 限制 `active=1`；
[export_all](https://github.com/NousResearch/hermes-agent/blob/e20ff352b91623d51ae05ea586a1800aee852402/hermes_state.py#L4353)
调用它时没有覆盖该默认值。原生公开 export 不能据此证明 inactive 历史完整覆盖。

[plugin LLM attribution](https://github.com/NousResearch/hermes-agent/blob/e20ff352b91623d51ae05ea586a1800aee852402/agent/plugin_llm.py#L544)
虽可读取 `response.model`，但不能证明主 Worker 回合的 export 保留该值；
[turn finalizer](https://github.com/NousResearch/hermes-agent/blob/e20ff352b91623d51ae05ea586a1800aee852402/agent/turn_finalizer.py#L331)
记录 `agent.model`。保持安装版 coverage/model 阻塞。

上游有比安装 checkout 新的版本；本轮研究拿到 main
`0e427d788d253630d38a3a51cd76849e73cd6925`，但新的 export 实现已迁移，
未定位其完整链。因此本轮不宣称“升级也无法修复”，也没有升级本机。

## Cline：3.0.71 是线索，未补足运行证据

本机仍是 CLI 3.0.70。直接读取官方
[CLI changelog](https://github.com/cline/cline/blob/main/apps/cli/CHANGELOG.md)
有 3.0.71 的插件运行、错误 hook 与 compaction 变更，未给出完整历史或响应
模型身份保证。当前
[HTML export](https://github.com/cline/cline/blob/main/apps/cli/src/session/export.ts)
呈现 `message.modelInfo.id`，不能自行证明字段来自 provider response。

本轮没有重新追新版 `persistSessionMessages` 写入侧，也未核验新版 SDK 编号。
原安装版 coverage partial/modelEvidence null 的证据保持有效；没有启动 Cline
角色、触碰 provider 文件或回滚交接中已记录的用户配置副作用。

## Muse 与 Cursor：官方前置条件更明确，仍待本机准备

直接获取官方文档原文，均为 HTTP 200；本轮未执行安装脚本、登录或调用两家模型。

Cursor [认证](https://cursor.com/docs/cli/reference/authentication)支持浏览器登录
和 Cursor Dashboard API key；[配置](https://cursor.com/docs/cli/reference/configuration)
公开的 `cli-config.json` schema 没有自定义 provider/base URL 字段，不能据此
规划复用 MiniMax endpoint。
[参数](https://cursor.com/docs/cli/reference/parameters)确认 `--resume [chatId]`、
`--model`、`--list-models`。
[hooks](https://cursor.com/docs/hooks)的 `sessionStart` 配置形状与既有 adapter
相符；通用 payload 有 conversation_id、workspace_roots 和可空 transcript_path。
其 model 字段描述的是 composer 配置，不是已证明的响应身份。

Muse [认证](https://dev.meta.ai/docs/muse-code/auth)要求 Meta credential；
[配置](https://dev.meta.ai/docs/muse-code/configuration)说明 schema_version 1、
managed hooks、模型选择与 retention，但没有本轮可用的 MiniMax 连接配方。
[交互会话](https://dev.meta.ai/docs/muse-code/interactive)说明
`muse resume <fork-id>`、workspace 内 `/resume`、trajectory export 和 trace inspect。
fork ID 与 adapter Session ID 的等价性仍待实际安装版核验。
[SDK hooks](https://meta-models.github.io/muse-code-sdk/next/guides/extend/hooks/)
示例固定在 Muse 1.3.0，SessionStart 有 UUIDv7 session_id、cwd，
transcript_path 可为 null、model 可为 unknown。managed hook 环境按 allowlist
传递，完整 transcript 的公开寻址还需核验。

SDK npm 元数据最新为 1.4.7，这不等于本机 CLI 版本；
[MSP wire](https://meta-models.github.io/muse-code-sdk/next/guides/msp-wire/)
本轮抓取截断后两次 TLS 失败，未取得 framing/caps 原文。
这两家仍需获准安装、用户原生登录和明确支持模型，再补测试 helper 的显式绑定，
不能仅设置验收 harness 开关就运行。

## 本轮代码与验证

仅修改验收 support 与既有矩阵测试。拒写读取原来按行解析，读不到 Kilo 的
pretty JSON export；现在复用已有 `transcriptRecords`。JSONL 保留不可解析行的
位置与隔断作用，既保留来源坐标，也避免跨损坏记录拼接 Antigravity 工具证明。
拒写仍限精确路径与 EROFS/EACCES/EPERM，assistant 文本、运行中 tool 不作证明。

验证：六候选 adapter、reporter 与矩阵的离线检查合计 **159 passed / 2 skipped**；
typecheck、两文件 ESLint 与 build 通过。真实 Kilo 子矩阵 **2 failed / 48 passed /
2 skipped**，失败范围如上。未运行完整 Controller、全量测试或跨平台检查。

## Kilo 后续：原生状态根修复，输入资格仍未通过

继续调查时，从原精确 Session 的原生日志取得独立原因：
`SessionHttpApi.prompt` 创建 `~/.local/state/kilo-sandbox-policy/<hash>` 被
EROFS 拒绝，发生在消息写入与模型请求之前。
[原生 SandboxStore](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/opencode/src/kilocode/sandbox/store.ts)
将 root 定义在 `dirname(Global.Path.state)/kilo-sandbox-policy`，与原生
`kilo` state 目录同级。它未被原 launcher 的三个精确根覆盖。

单变量原型只增加该 root，同一只读提示即得到最终答复。最终代码只保留这处
runtime 根修复及对应 fixture、真实 bwrap 回归；workspace、Git、协调文件仍
返回 EROFS，协调哨兵内容不变，共享 overlap 与 seccomp 规则继续生效。
没有把 config 目录或用户 home 整体设为可写。

最后沿生产 `kiloHarness.prepareReadOnlyLaunch` 与原生 `--prompt` 重验：Session
`ses_ec6596f4effeiM6qVIg5GzeT0P` 的 adapter proof 为 proven，完整 coverage 成立，
精确公开 export 有用户消息与最终 `KILO_FINAL_ROOT_CHECK_20261014` 答复。
这证明首次只读模型轮次已解开，仍不代表只读 Finalizer/Recovery 角色资格通过。

输入捕获显示 Orca 只写入一次完整 bracketed-paste preamble，再写一个 `\r`。
系统 PTY 对照完成简短任务和 Implementation；随后正式完整矩阵中 Planner 通过，
Implementation/Validator 无 Session 报告，Finalizer 在覆盖核验窗口内不可证明，
resume/Recovery/Validator 续接均因原身份不可用而拒绝。该轮
**2 failed / 50 passed / 2 skipped**，证据为
[完整矩阵](../../artifacts/next-worker-harness-adapters/ip04-2026-10-14T08-44-08-445Z-41c485aa-165c-44ec-b59c-8e1ed5fd46b6.json)。
稍后 Finalizer 的两个精确 export 相等，不改写原失败结论。

另行 stdout/stdin 转发对照各有 Implementation 成功，但原样转发的 Finalizer
仍无报告，且 stdin pipe 令原生 PTY 缺少窗口尺寸。输入桥与独立 PTY 方案均未
保留在生产 launcher；没有增加 Enter、固定等待或重发旧任务。`strace` 对原进程
的只读 attach 被系统以 `Operation not permitted` 拒绝，没有改变主机权限。

最终 **2554 passed / 18 skipped**（213 文件通过、9 跳过），限定回归 73 passed，
typecheck、ESLint、build、OpenSpec strict 与 diff 检查通过。十个已结算或确定为
失败启动后空闲 shell 的精确终端已公开关闭；其余未结资源、协调终端、unknown
与全部文件保留。没有新增生产注册，也未启动 mixed Controller。
原始错误、最终只读 proof、各输入原型和清理回执见
[修复证据](../../artifacts/next-worker-harness-adapters/kilo-readonly-resolution-20261014.json)。
