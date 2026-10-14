# Antigravity `agy` 原生结构化输入与终端能力

抓取日期：2026-10-13。来源为 Google 官方文档站 `antigravity.google/docs`，外加本机随安装分发的第一方内置参考
`~/.gemini/antigravity-cli/builtin/skills/antigravity_guide/references/cli.md`（该文件只指向线上文档，自身不含
stream-json 细节）。CLI 为闭源分发，官方没有公开源码仓库；本文区分文档事实与本机实测，后者来自
2026-10-13 的受控探针。适用版本：文档最新条目为 CLI **v1.3.1（2026-10-07）**，本机安装为
**1.3.4**，1.3.2–1.3.4 在公开 changelog 中没有条目。

## 结论

1. `--input-format stream-json` 的输入协议只有一个消息形态：`{"event":"user","message":{"content": <string | text
   blocks>}}`。`text` 是唯一支持的 block 类型，其它类型、缺 `event`、非法 JSON 都产生 ERROR result 并**终止整个
   session**（退出码 1）；未知 `event` 名字被跳过并向 stderr 告警；`control_request`/`control_response` 与 CLI 自处理
   的 slash 命令使 session 结束（退出码 2）。
2. 原生进程的初始化信号是 stdout 的第一行 `init` 事件：一次进程只发一次，含 `conversation_id` 与 `cwd`、`tools`、
   `permission_mode`、`model`、`agent`。它不替代 Orca 的公开就绪回执。文档没有第二个 ready 事件或控制通道。
3. 一个 streaming 进程 = 一个 `conversation_id`；每个 turn 以一个 `result` 事件收尾；`num_turns`、`usage`、
   `duration_seconds` 是**整场会话累计值**，只有 `response` 属于当前 turn。关闭 stdin 即优雅结束（干净会话退出 0）。
4. 文档没有说明 hooks 在 `--print`/headless 模式下是否触发。本机 1.3.4 的只读模型探针已取得 hook 报告，并与精确
   native metadata/transcript 独立匹配；这个实测结果不扩大到其他版本。
5. 没有任何公开文档化方式关闭 TUI 的周期性终端协议重申。`settings.json` 的完整键表里没有 Kitty 键盘协议、
   `modifyOtherKeys` 或 bracketed paste 相关项；`altScreenMode` 只控制备用屏幕缓冲。changelog 承认渲染器会
   **周期性重臂 Kitty 协议**，并且修过非 Kitty 终端上因此出现字面 `a` 的 bug，但重臂本身仍存在。本机实测
   `TERM=dumb` 仍每约 2 秒重申 `ESC[?2004h` 与 `ESC[>4;2m`。

## 输入协议（`--input-format stream-json`）

前提：文档明确 `--input-format stream-json` **要求** `--output-format stream-json`，且此时 `-p/--print/--prompt` 传入的
prompt 会被**丢弃**——streaming 模式只从 stdin 读提示。

| 输入行 | 文档化结果 | 退出码 |
| --- | --- | --- |
| `{"event":"user","message":{"content":"…"}}` | 执行一个完整 turn | — |
| `content` 为 `[{"type":"text","text":"…"}]` | 与字符串形式等价 | — |
| `content` 里的非 `text` block | ERROR result，session 结束 | 1 |
| 缺 `event` 字段 | ERROR result，session 结束 | 1 |
| 非法 JSON 行 | ERROR result，session 结束 | 1 |
| 未识别的 `event` 名（如 `future_thing`） | **跳过**，stderr 打印 `warning: ignoring unsupported stream input message event "…"` | — |
| `control_request` / `control_response` | ERROR result，session 结束 | 2 |
| CLI 自己能处理的 slash 命令（`/model`、`/usage` 等） | ERROR result，session 结束 | 2 |

slash 命令的错误文案原文形如 `/model is answered by the CLI itself and is unavailable with --input-format stream-json;
run it as its own --print /model invocation`，即官方把这些命令定位成独立的一次性调用。

官方给出的交互式驱动形状：写一行 `user` 事件并 flush，逐行读 stdout，**收到当前 turn 的 `result` 后再写下一个
prompt**；结束方式是关闭 stdin 之后 `wait()`。文档警告不要等进程退出再读 stdout，因为会话会一直开着。

## 输出协议（`--output-format stream-json`）

事件键 `event` 取三个值：`init`（一次，开场）、`step_update`（任意多次）、`result`（一次，收尾）。

`init.init` 字段：`cwd`、`tools: string[]`、`permission_mode`、`model`（仅 `--model` 时）、`agent`（仅 `--agent` 时）、
`json_schema`（仅 `--json-schema` 时）。`conversation_id` 在 `init` 的**同级**而不是 `init` 内部——官方示例是
`{"event":"init","conversation_id":"…","init":{…}}`；本机 1.3.4 实测形状一致。

`step_update.step_update` 字段：`conversation_id`、`step_index`（0 基）、`state`（`ACTIVE`/`DONE`）、
`step_type`（`user_input`、`agent_response`、`tool`、`checkpoint` 等）、`tool_name`、`text_delta`、`duration_seconds`、
`usage`、`tool_info`（`name`/`parameters`/`output`/`error`）、`subagent_info`（`subagents[]`，含 `type_name`、`role`、
`conversation_id`、`log_uri`、`workspace_uris`）。流式文本可能先出若干 `ACTIVE` 的 `agent_response`（带
`text_delta`），最后一条 `DONE` 带 `duration_seconds` 与 `usage`。

`result.result` 与 `--output-format json` 的单对象同形：`conversation_id`、`status`、`response`、`error`、
`duration_seconds`、`num_turns`、`structured_output`、`json_schema`、`usage`。`status` 取值：`SUCCESS`、`ERROR`、
`CANCELED`、`INTERRUPTED`、`INVALID`、`WAITING`、`RUNNING`。

统计口径：`response` 是当前 turn 的文本；`num_turns`、`usage`、`duration_seconds` 是全会话累计。

## 会话连续性与 `--conversation`

- `--continue`/`-c`：续接**最近一次**会话；`--conversation <ID>`：续接指定会话。文档把两者都放在「一次进程一个
  turn」的 `-p` 语境下描述：「Each of these starts a new process.」
- 需要同一进程多轮时才用 `--input-format stream-json`；文档强调它省掉每轮启动开销、复用已热的会话。
- 官方示例里两轮共用同一个 `conversation_id`，`init` 只出现一次。
- **未记载**：`--conversation` 与 `--input-format stream-json` 同时使用会发生什么。flag 表没有互斥说明，也没有示例。
  本机 1.3.4 已用精确 ID 完成两轮 stream resume，保留原 Session、哨兵上下文与 nonce；文档缺口与本机证据分开记录。
- 会话身份的落盘位置由 hooks 文档间接给出：`<app_data_dir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`，
  CLI 的 `<app_data_dir>` 是 `~/.gemini/antigravity-cli`。

## Hooks：语义与 print 模式缺口

配置位置（CLI）：工作区 `.agents/hooks.json`；全局 `~/.gemini/config/hooks.json` 或主
`~/.gemini/antigravity-cli/settings.json` 内；插件包内 `hooks.json`。hook 处理器字段只有 `type`（目前仅 `command`）、
`command`、`timeout`（默认 30 秒）。

事件：`SessionStart`（新会话开始、**首次模型调用之前**，matcher 忽略）、`PreToolUse`（工具执行前，matcher 可按
工具名或正则）、`PostToolUse`、`PreInvocation`、`PostInvocation`、`Stop`。

所有 hook 通过 stdin 收 JSON、通过 stdout 返 JSON，字段为 camelCase。公共输入字段：`conversationId`、`workspacePaths`、
`transcriptPath`、`artifactDirectoryPath`、`modelName`。

- `SessionStart` 输出可选 `injectSteps`（注入到会话轨迹开头，schema 同 PreInvocation）。
- `PreToolUse` 输入额外有 `toolCall{name,args}` 与 `stepIdx`；输出必须含 `decision`，取值
  `allow` / `auto_approve` / `deny` / `ask` / `force_ask` / `deny_unless_prior_grant`，另有可选 `reason`、`overwrite`
  （浅合并进 `toolCall.args`）、`permissionOverrides`（如 `read_file(/path)`、`command(args)`）。

文档缺口：整页没有任何 print/headless/非交互模式的适用性说明，也没有「hooks 在 `-p` 下被跳过」的否定式声明。同时也没有
说明 `--conversation` 续接算不算「new conversation session」从而触发 `SessionStart`。这两点决定了 reporter 能否在
结构化模式下仍然证明精确 Session 身份，不能靠文档推定。

## 权限、退出与错误（headless 语义）

- headless 没有交互提示：需要审批而拿不到的工具按**软拒绝**处理，运行继续、退出码仍为 0，只在 stderr 点名被拒工具
  与放开方式。工作区内的读写自动允许，shell 命令默认 `Ask`。
- 预先放行规则写在 `~/.gemini/antigravity-cli/settings.json` 的 `permissions.allow`，语法如 `command(git)`、
  `command(regex:npm run (build|lint|test))`、`write_file(src/)`；`--dangerously-skip-permissions` 全量自动批准；
  `--sandbox` 打开终端沙箱限制。
- 未知 `--model` 不会静默回退，直接 ERROR 退出（退出码 1），这是流水线需要的 fail-loud 行为。
- changelog 记录：流式输出中途出错时 headless 退出码从 0 改为 3 并打印 `AGY_ERROR` 行，而**多轮 stream-json 会话
  对中途错误只告警并继续**。本机 1.3.4 对 SIGINT/EOF 的实际退出码与 `result.status` 组合，本篇不做断言。

## 终端能力配置：没有公开的关闭开关

`settings.json`（CLI reference 的完整键表）中与终端相关的只有：`colorScheme`、`altScreenMode`
（`default`/`always`/`never`，仅决定备用屏幕缓冲）、`enableTerminalSandbox`、`notifications`、`verbosity`、
`runningLightSpeed`、`editorMode`/`vimInsertFirst`、`showTips`、`showFeedbackSurvey`。**不存在** Kitty 键盘协议、
`modifyOtherKeys`、bracketed paste 的开关或环境变量。

changelog 里的相关事实：

- v1.1.16：修复「在不支持 Kitty 键盘协议的终端上，渲染器**周期性重臂该协议**被当字面文本打印、prompt 里每几秒
  累积一个 `a`」。这条同时是官方对「周期性重臂确实存在」的确认。
- v1.2.6：升级 Bubble Tea v2.0.9，修复退出与清屏时的 Kitty 键盘协议栈处理。
- `CLI_GRAPHICS=kitty` 是唯一文档化的 Kitty 相关环境变量，但作用是**强制图形模式**，不是键盘协议。
- 官方另有通过 terminal identify 探测图像能力、SSH/tmux 下不发探测序列等修复，均属图像而非键盘协议。

本机实测（父 agent，1.3.4、原生 PTY、`TERM=dumb`）：仍每约 2 秒重申 15 字节 `ESC[?2004h` `ESC[>4;2m`，不新增
文本但持续刷新输出时钟。与文档一致的是「没有公开开关」；「TERM=dumb 可关闭」没有文档依据且实测被否。

## 文档漂移与未知

- `--print-timeout` 默认值漂移：headless 页写默认 5 分钟，changelog 有一条把它改成「无限」，另一条又写 headless run
  等后台任务直到 `--print-timeout` 截止、上限 30 分钟。以本机 `agy --help` 为准。
- 公开 changelog 最新 CLI 条目是 v1.3.1，1.3.4 的行为差异无官方记录。
- `--print` 的**空值形式**（`--print=`）在文档中不存在：文档只把 `-p/--print/--prompt` 描述为「带一个 prompt 运行
  一次」。本机实测裸 `--print` 会吞掉下一个 flag 作为 prompt，必须写 `--print=`。这是实机观察，不是文档结论。
- 是否存在官方未公开的 CLI 参数：本文不做任何此类推测（用户明令不得推断私有选项）。
- SDK 侧 `/docs/sdk/lifecycle` 的 hook 文档与 CLI hook 文档是否同构、以及 SDK 事件与 CLI stream-json 事件的映射关系，
  未在本次取证范围内核对。
- 文档描述「streaming 模式忽略 `-p` 的 prompt」与「`--print=` 必须存在」可以并存：后者的作用是进入 headless 启动路径。
  组合行为（`--print=` + `--input-format stream-json`）文档未给示例。

## 对父任务的直接含义

1. stream 模式从 stdin JSON 读输入，每轮以 `result` 收尾，避开了本机 TUI 的周期协议重申。Companion 仍需承接 Orca
   的 prepared terminal、真实 agent 识别、文本 preamble 提交与监督生命周期，不能据此跳过公开就绪和接管合同。
2. 1.3.4 的 hook 与 exact conversation resume 已受控实测。现有报告器、精确 metadata/transcript 和 bwrap/seccomp
   可以复用；native 权限自动批准不替代 OS 只读边界。
3. 临时 launcher 内的单轮输入转换已通过公开就绪、worker-start、精确 Session/完整覆盖、native SUCCESS 与唯一
   worker_done 的监督结算和 Delivery ack。外层 bridge 则就绪但 agent_unconfigured；具体 foreground 分类规则未证明。
   新模式的连续回复、取消、恢复与完整 Controller 仍待验收，不能注册。

## 本机实测（2026-10-13，Orca 1.4.224 / agy 1.3.4）

只读 native 探针成功读取哨兵，追加写入被 OS 拒绝，哨兵不变；exact resume 的两轮 result 都为 SUCCESS，
会话 ID、旧上下文与新 nonce 保持。stream 无周期 ANSI。对应临时记录：

- `/var/tmp/ocp-agy-print-proof-20261013-Kl1VUT/result.json`
- `/var/tmp/ocp-agy-stream-resume-20261013-9iSr4I/result.json`

公开监督单轮探针在本项目实际 launcher 内增加 stdin framing，保留 native stdout/stderr、真实环境和生产只读
包装。Orca 提交的 87 行 preamble 只转换一次，marker 与 `中文🌊` 完整；模型读取 package.json 后返回 SUCCESS。
Session `97e98418-f9a5-4565-b229-d26d14748bad` 与 hook/native transcript 匹配，完整覆盖为 step:0–7。
`worker-start` 的 input_accepted 和 unsupported turnStart 本身不证明轮次开始；最终由真实 native 结果和
succeeded/completed 结算共同证明。唯一 worker_done 核验身份、存证后整批 ack。

原型只支持一轮输入，未实现生产 result 驱动、排队、取消或 EOF。stdout 继承对照排除了「仅改输出转发即可接入」；
无转换原生启动通过识别但真实派发后 process_exited/exit 1，不作为拒绝且不换 ID 重试。具体输入错误未捕获。
原型及原始输入仅存于 0600 临时工件，完整 preamble/能力值不入仓库。七个自建诊断终端在公开证明 exited 后关闭，
原 Controller 资源保持。

可审阅的脱敏回执见[桥接证据](../../artifacts/next-worker-harness-adapters/antigravity-stream-bridge-20261013.json)；
生产资格以[本轮 SSOT](next-worker-harness-adapters.md#原生事实与当前验收)为准，仍是 9/12、新增注册 0。

## 复验入口

```bash
agy --help | rg -n 'input-format|output-format|print|conversation|print-timeout'
```

下列命令会真实调用模型，只在已授权的验证轮次执行：

```bash
printf '%s\n' '{"event":"user","message":{"content":"…"}}' \
  | agy --input-format stream-json --output-format stream-json --model <slug> --print=
```

该命令仅展示原生协议，不含 Companion 的只读包装、报告和 Orca 监督接管。

## 来源

- [Headless mode](https://antigravity.google/docs/cli/headless/)：stream-json 输入输出 schema、错误表、累计计数、
  `--print-timeout`、权限、退出码与 flag 表。
- [Lifecycle hooks](https://antigravity.google/docs/hooks/)：hook 位置、事件表、SessionStart/PreToolUse 的 stdin/stdout
  合同、`<app_data_dir>/brain/<conversationId>/…/transcript.jsonl` 路径。
- [CLI reference](https://antigravity.google/docs/cli/reference/)：`settings.json` 完整键表（终端相关项全集）、TUI 键位。
- [Changelog](https://antigravity.google/docs/changelog/)：Kitty 键盘协议周期性重臂、退出码 3 与 `AGY_ERROR`、
  `--print-timeout` 默认值变更、最新 CLI 版本 v1.3.1。
- [Managing conversations](https://antigravity.google/docs/cli/conversations/)、[/resume](https://antigravity.google/docs/cli/commands/resume/)：
  会话续接的用户侧语义，未给出与 streaming 输入的组合说明。
- 本机第一方内置参考 `~/.gemini/antigravity-cli/builtin/skills/antigravity_guide/references/cli.md`：确认配置路径为
  `~/.gemini/antigravity-cli/settings.json`，并指向线上文档为权威来源。
