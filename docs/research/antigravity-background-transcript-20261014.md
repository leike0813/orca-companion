# Antigravity `agy` 1.3.4 后台 tool task 的可核验终态与 transcript 协议

抓取日期：2026-10-14。来源为 Google 官方文档站 `antigravity.google/docs`、公开仓库
`github.com/google-antigravity/antigravity-cli` 的 `README.md` 与 `CHANGELOG.md`，以及本机 `agy --version` /
`agy --help` 的只读输出（1.3.4）。CLI 为闭源分发，无公开源码仓库，因此不存在「读一手源码」这条路。

## 结论

1. 在所查 CLI、hooks 与后台任务文档中，**未找到**面向外部调用方的「单个后台 tool task 终态」查询接口。headless 的机器可读运行状态是 turn 级的
   `result.status`（`SUCCESS` / `ERROR` / `CANCELED` / `INTERRUPTED` / `INVALID` / `WAITING` / `RUNNING`），
   不含 task id，也不含 task 级终态字段。`manage_task`（`list`/`kill`/`status`/`send_input`）是 **agent 内部工具**，
   只能由模型在 turn 内调用，其返回结构无任何文档。
2. **未找到** CLI 侧 session / transcript 结构化导出。1.3.4 的 `agy --help` 子命令里不存在 `session`、`export`、
   `transcript`、`tasks`；与 session 相关的只有 `--conversation <id>`（恢复）与 `--continue`。README 里的
   “Session Export” 指的是**导出到 Antigravity 2.0 GUI 继续工作**，不是给程序读的格式。
3. **本次查到的结构化「后台任务已全部结束」信号是 `Stop` hook 的 `fullyIdle` 布尔字段**。
   它只在执行循环终止时触发，且需要安装 hook；它本身不证明 transcript 事件覆盖。
4. **没有任何官方文档化的 transcript.jsonl schema**，也没有「事件完整覆盖」保证。文档只给出文件路径
   （通过 hook 的 `transcriptPath` 字段下发）。changelog 里有三条反向证据：该日志曾漏记 `ERROR` 步骤、
   曾因后台消息与压缩并发写入而损坏、曾省略超大 diff 正文。因此「结构完整」不能由官方背书。
5. 因此，本项目观察到的现象——MODEL/GENERIC/RUNNING 行永不翻成 DONE、另起一条 SYSTEM/SYSTEM_MESSAGE/DONE
   行承载终态文本、`task-N.log` 为 0 字节——**与官方文档不矛盾，也无法用任何公开协议判定为「协议违规」**。
   官方从未承诺 transcript 记录行会被就地改写，也从未承诺后台 task 会留下非空的 `task-N.log`。

## 一、官方保证（文档明文）

来源：<https://antigravity.google/docs/cli/headless.md>（`--output-format stream-json` 与 `json` 信封）

- 事件只有三个键：`init`（一次）、`step_update`（任意多次）、`result`（一次收尾）。
- `step_update.step_update` 的字段表：`conversation_id`、`step_index`（0 基）、`state`、`step_type`、
  `tool_name`、`text_delta`、`duration_seconds`、`usage`、`tool_info`、`subagent_info`。文档措辞是
  “**Observed** `step_type` values include `user_input`, `agent_response`, `tool`, and `checkpoint`”，
  即这是观察清单而非封闭枚举。
- `state` 只有 `ACTIVE`（运行中）与 `DONE`（该 step 结束）两值，语义绑定在**同一 `step_index` 的同一条流事件**上。
- `tool_info` 含 `name`、`parameters`、`output`，失败时含 `error`（`type` / `message`）。
- `result` 是 turn 级：`conversation_id`、`status`、`response`、`error`、`duration_seconds`、`num_turns`、`usage`。
- 文档**没有任何** background task 专属事件类型、task id 字段或 task 级 status 字段。

来源：<https://antigravity.google/docs/cli/headless.md>（超时与后台任务等待）

- `--print-timeout` 到期时的行为、以及 headless 运行会等待运行中的后台任务，是 changelog 而非当前文档页的行为；
  该文档页仍写「默认等待 5 分钟」，与 `agy --help` 的 `--print-timeout (default 0s)`（无限）和
  changelog 1.2.8「默认超时改为无限」矛盾。**文档在此处滞后于 1.3.4 实际行为**，不要据此推断。

来源：<https://antigravity.google/docs/hooks.md>

- hook 通过 stdin 收 JSON、stdout 回 JSON。公共字段含 `conversationId`、`workspacePaths`、
  **`transcriptPath`**、`artifactDirectoryPath`、`modelName`。
- `transcriptPath` 的官方定义与位置：
  `<app_data_dir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`，
  CLI 的 `app_data_dir` 为 `~/.gemini/antigravity-cli`。
- `Stop` 输入字段：`executionNum`、`terminationReason`、`error`、**`fullyIdle`（必填）**、公共字段。
  `fullyIdle` 原文语义：“`true` if the agent is completely finished and all background commands or
  asynchronous tasks have completed. `false` if active background tasks are still running.”
- `Stop` 输出字段：`decision`（设为 `"continue"` 可阻止 agent 停止并重新进入执行循环）、`reason`（可选，
  作为 system message 注入会话）。
- `PostToolUse` 输入字段：`toolCall`（`name` + `args`）、`stepIdx`、`error`、公共字段；输出恒为 `{}`。
  官方示例正是 `run_command` 带 `WaitMsBeforeAsync: 5000` 且 `error: "exit status 1"`。
- `manage_task` 在工具表里只有一行：`Action`（`list`/`kill`/`status`/`send_input`）、`TaskId`、`Input`。

来源：<https://antigravity.google/docs/cli/reference.md> 与 <https://antigravity.google/docs/subagents.md>
（后者是 `/docs/cli/subagents` 的规范重定向目标）

- `/tasks` “Open the Task Manager panel to monitor background shell execution logs”，Enter 查看 stdout 日志、
  可终止进程；`/agents` 面板显示 subagent 的 live lifecycle state（`running` / `done` / `killed` / `error`）。
  两者都是 **TUI 面板**，没有对应的 `--json` 变体。
- subagent 的三态是 `Running` / `Idle`（已完成并回传结果、收到消息会重新唤醒）/ `Killed`（永久终止）。
  文档只说 “Historical conversation transcripts remain readable in JSONL logs”，不给 JSONL 的结构。

来源：<https://antigravity.google/docs/cli/commands/resume.md>

- 唯一的官方 JSON 文件是 `~/.gemini/antigravity-cli/cache/last_conversations.json`，
  内容是「workspace 绝对路径 → 最近活跃 conversation id」的映射。**不含任何任务状态**。

来源：`README.md`（仓库 `main`）

- “**Session Export**: Export terminal sessions to the Antigravity 2.0 GUI to continue working.”
  这是 GUI 交接，不是程序可消费的导出格式。

## 二、changelog 证据（版本归属已核对）

来源：<https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md>
（2026-10-14 抓取，`main` 顶部条目为 `## 1.3.4`；wiki 固定快照为
`blob/274d81b9929aaa2b91a7266106d0d0b7f19adf52/CHANGELOG.md`）

| 版本 | 条目 | 与本问题的关系 |
| --- | --- | --- |
| 1.3.1 | `/tasks`、active task 列表、状态行此前只显示后台 shell 命令；计时器与其他后台工具现在也出现，并标为 `completed` 或 `failed`，**不带编造的 exit code** | 官方承认后台任务状态词汇存在，且此前显示有误 |
| 1.2.9 | headless 运行曾在 agent 变 idle 后约 5 秒取消仍在跑的后台任务；改为等到 `--print-timeout` 截止，上限 30 分钟 | headless 下的后台任务寿命由超时决定，不由模型决定 |
| 1.2.8 | headless 默认超时由 5 分钟改为无限 | 官方文档 `headless.md` 此处仍写 5 分钟，文档滞后 |
| 1.2.7 | headless 偶发跳过后台任务等待提示、**把后台 SDK 工具进度写进 task log 文件** | `task-N.log` 属于实现产物，无格式文档、无完整性承诺 |
| 1.2.5 | 被外部信号杀掉的命令曾被记成 exit code 0 的成功；现在**以 canceled 结束并保留中断前已收集的输出** | 与观察到的 “was canceled with result: Tool execution was canceled” 语义一致 |
| 1.2.5 | 状态行、active-items 列表、`/tasks` 面板**继续显示已结束的后台任务** | 派生态（derived）状态会过期，不能当作终态证据 |
| 1.2.5 | 后台消息在压缩重写 transcript 时并发追加，导致 transcript 出现不合法 JSON | 完整性反证：同一文件曾被官方承认损坏 |
| 1.2.4 | 终端 `ERROR` 步骤（工具失败、超时等）此前**被漏记**进 `transcript.jsonl` | 覆盖完整性反证：曾有官方承认的事件缺失 |
| 1.2.6 | 单文件 diff 超 1 MiB 时只保留行变更统计，**从存储的会话历史里省略原始 diff 正文** | 主动裁剪；`/rewind` 也跳过 |
| 1.2.x | subagent 曾在已结束后仍显示 running（尤其超大会话），导致 when-idle 消息直到重启才投递 | 「卡在 RUNNING」是官方承认的缺陷类别，不是孤例 |
| 1.2.x | 连续 `continue` 达到可配置次数后，stop hook 不再能阻止，turn 正常结束 | `Stop`/`fullyIdle` 是唯一的排空闸门，但闸门有上限 |
| 1.2.x | 执行路径合并为单一路径，带来「更一致的 tool、hook、prompt 行为」 | 弱证据，暗示 hook 与交互/print 共用路径；**不构成 print 模式跑 hook 的文档保证** |
| 1.3.3 | `/btw` 旁路提问此前会跑用户与工作区 hook（可能导致 stop hook 循环） | hook 确实会在交互会话中触发 |

## 三、观察（本机 / 本项目既有证据，非官方承诺）

- 本机 `agy --version` = `1.3.4`；`agy --help` 的子命令全集为 `agent(s)`、`changelog`、`help`、`install`、
  `mcp`、`mic-serve`、`models`、`plugin(s)`、`remote-control`、`update`——**没有任何 session / export / task 子命令**。
- 本项目 2026-10-13 的受控探针在 1.3.4 headless（`--print`）下取得过 hook 报告，并与精确的 native
  metadata / transcript 独立匹配（见 `docs/research/antigravity-native-input-20261013.md`）。
  官方文档**没有**任何一句说明 hook 在 `--print` / headless 下触发或不触发，因此这只是单版本单次观察。
- 本项目 hook 实测报告的文件名 `transcript_full.jsonl` **不是官方文档里的名字**；文档列出
  `transcript.jsonl`，且路径应由 hook 的 `transcriptPath` 字段给出，而不是靠猜路径。
- 本项目当前的 `recoveryInstructions` 对照只改了这一点：要求只读精确 transcript、不搜索 schema 或 Orca 文件，
  并用原生 `run_command` 的 `IsDaemon=false`、`RunPersistent=false`、`WaitMsBeforeAsync=30000` 走前台精确读取。
  按该设置执行后没有出现 `RUNNING` 行——因为命令从未被后台化，属于「绕开缺口」而非「缺口被修复」。
  注意 `IsDaemon` **不在**官方 `run_command` 参数表内（文档只列 `CommandLine`、`Cwd`、`WaitMsBeforeAsync`、
  `RunPersistent`、`RequestedTerminalID`），它在本机被接受只是实现事实，不能当作受支持参数。
- 本项目此前两次失败（对全 HOME 与 Orca 配置做 grep）是被原生 cancel 的，但对应记录行**永久停在 `RUNNING`**，
  终态只出现在另起的 SYSTEM/SYSTEM_MESSAGE 行里。这与 changelog 1.2.5「被外部信号杀掉的命令以 canceled 结束」
  的语义一致，也再次确认：官方没有承诺落盘行会被就地改写。

## 四、明确的缺失（未找到公开保证）

1. 没有公开的 **per-task 终态 API**：`manage_task status` 的输出 schema、`TaskId` 的取值域与生命周期，
   都只存在于模型工具描述里，不在 CLI 或文档契约里。
2. 没有公开的 **transcript.jsonl schema / 版本字段 / 状态机定义**：文档只给路径。`source` / `type` /
   `status` / `content` 这套字段名没有任何官方出处。
3. 没有 **事件完整性保证**：至少两条官方承认的历史缺失/损坏（1.2.4 漏记、1.2.5 损坏）加一条主动裁剪（1.2.6）。
4. 没有 **「记录行会被就地改写为终态」** 的承诺。stream-json 里 `ACTIVE → DONE` 的语义绑定在流事件上，
   不构成对落盘日志的承诺。
5. 没有 **hook 必达的保证**：文档未说明 print/headless 模式，也未说明后台进程稍后终止时
   `PostToolUse` 是否触发、是否携带退出码。
6. 没有 **task log 文件的格式或非空保证**：`/tasks` 面板按需读 stdout，changelog 只说进度会被写进去。
7. 没有 **`IsDaemon` 参数的文档**：`RunPersistent` 有文档，`IsDaemon` 只存在于本机调用。

## 五、对本项目的可用结论

- `Stop.fullyIdle` 是后续生命周期核验可调查的公开来源；需要与精确 Session、执行轮次和
  transcript 覆盖独立绑定。当前未实现该接线，也不改变原生 Stop 行为。
- 想要「某个具体后台 task 的终态」，官方没有外部接口；`manage_task` 只能由模型在 turn 内自证，
  不能作为外部核验来源。SYSTEM/SYSTEM_MESSAGE 行是**非结构化正文**，只能作为线索，不能作为协议判据。
- 当前 adapter 按已实测版本核验精确 transcript 的结构与连续事件；未知、缺失或活动事件
  fail closed。缺少官方 schema/覆盖保证意味着后续版本仍需真实回归，不能泛化支持声明。
- 当前「只读精确 transcript + 前台 `run_command`」的对照设置应记为**规避缺口的做法**：它让恢复不再产生
  不可核验的后台 task，但也意味着这条路径不再提供任何后台终态证据。

## Sources

- <https://antigravity.google/docs/cli/headless.md>
- <https://antigravity.google/docs/hooks.md>
- <https://antigravity.google/docs/cli/reference.md>
- <https://antigravity.google/docs/subagents.md>（`/docs/cli/subagents` 规范重定向目标，CLI tab）
- <https://antigravity.google/docs/cli/commands/agents.md>
- <https://antigravity.google/docs/cli/commands/resume.md>
- <https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md>（顶部条目 1.3.4）
- <https://github.com/google-antigravity/antigravity-cli/blob/274d81b9929aaa2b91a7266106d0d0b7f19adf52/README.md>
- 本机只读命令：`agy --version`（1.3.4）、`agy --help`
