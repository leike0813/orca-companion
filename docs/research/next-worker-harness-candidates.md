# 下一批 Worker Harness：候选资格与证据边界

记录日期：2026-10-11。范围为 Ubuntu 本机、本次 `add-testable-worker-harness-adapters` change；Orca 实际版本为 **1.4.222**，Linux 公共命令为 `orca-ide`（父线程已核验）。本文汇总既有消息、留存现场、已安装包与官方源码/文档，不新增模型调用、Orca 操作、安装或配置修改。IP-01/03 对本文列出的 18 个候选所需官方 help/source bounded 资格评估均已完成；这表示本轮文档调查已闭合，不代表所有候选的真实运行验收通过，也不替 parent 作最终资格决定。

## 结论与证据层级

固定上游快照 `cc5c85fb7a43ed52c6cd29157210020cd769d84c` 的 [`tui-agent-config.ts`](https://github.com/stablyai/orca/blob/cc5c85fb7a43ed52c6cd29157210020cd769d84c/src/shared/tui-agent-config.ts#L27) 配置并由 [`tui-agent.ts`](https://github.com/stablyai/orca/blob/cc5c85fb7a43ed52c6cd29157210020cd769d84c/src/shared/tui-agent.ts#L3) 声明本次核对的 17 个候选 builtin ID：`codebuddy`、`autohand`、`prime-agent`、`antigravity`、`goose`、`kilo`、`crush`、`cline`、`command-code`、`cursor`、`droid`、`kimi`、`mistral-vibe`、`qwen-code`、`hermes`、`copilot`、`grok`。[`agent-process-recognition.ts`](https://github.com/stablyai/orca/blob/cc5c85fb7a43ed52c6cd29157210020cd769d84c/src/shared/agent-process-recognition.ts#L41) 从该配置构建类型 ID 与进程识别表；[`runtime-worktree-startup-readiness.ts`](https://github.com/stablyai/orca/blob/cc5c85fb7a43ed52c6cd29157210020cd769d84c/src/main/runtime/runtime-worktree-startup-readiness.ts#L79) 用识别结果判断启动就绪。这仅说明上游 builtin 身份与对应代码路径存在，不代表本机 Orca 1.4.222 运行支持、hook/transcript 能力或 Companion 适配通过。MiniMax Code (`mcode`) 不在 `tui-agent.ts` union、`tui-agent-config.ts` 配置或上述识别来源中，是独立的 Orca builtin identity 缺口；它本轮 `excluded-current-round` disposition 仍按现有具体资格理由记录，不将此源码差异推断为本机运行结论。

Command Code 与 Qwen Code 已通过 IP-04 Worker matrix 与独立混合 Controller。矩阵覆盖四角色、native model/session/transcript、exact resume、Validator 同 Session context continuation 与 Recovery Utility；fresh fixture `zX9uxn` 为 45 passed / 2 skipped、730.57 秒且 global hash unchanged。混合 Controller 的 `p0vZXM` fixture 完成人工中断 Validator、Capsule、替代 Validator、集成与私有 origin 推送，取得 deliverable，并核验同 Scope 重启绑定、结算与预算不变。两项已正式注册。CodeBuddy 按 D01 排除。Grok 已有真实目标模型响应及独立 transcript identity 证据，coverage parser 对不连续事件号只保守标记 partial；原生默认值与持久化触发条件仍 unknown。各项通过只覆盖其明确证据范围。

统一记录三类事实：

Command Code 的项目 taste learning 默认值会在原生启动时创建 `.commandcode/taste/taste.md`。真实 Controller 在 WLT15T 的 README 工作包中拒绝了这项越界路径，见 [阻塞证据](../../artifacts/next-worker-harness-adapters/controller-blocked-taste-20261011.json)。后续隔离 fixture 在授权前把原生 `.commandcode/settings.json` 的 `tasteLearning:false` 纳入基线；不改用户全局设置、不隐藏 Git 路径，生产 adapter 仍继承原生配置。启用原生项目 learning 的严格范围任务可能因此被拒绝交接。

- **native proof passed**：注明具体通过项，例如真实 assistant 模型、精确 transcript identity 或同 Session resume；不自动包括其他项。
- **bounded production adoption passed**：只表示记录中列明的 Orca path、harness identity、精确 Session 与 transcript 覆盖均有收据；不自动覆盖其他 role、resume、Recovery 或 ABI。
- **unknown / not run**：官方文档、版本核验或真实证据尚不足；不转换成排除结论。

## IP-01 / 03 current-round disposition (SSOT)

状态只表示本轮范围：`evidence-qualified` = 本表明确命名的资格阶段证据已齐；`excluded-current-round` = 已有具体必要能力缺口或 D01 决定，本轮不纳入；`waiting-verification` = 有可行公开路径，但认证或真实运行验证尚未完成。官方 help/source bounded 评估已全部完成；waiting 项可在补齐所列证据后重新评估。Command/Qwen 的资格包含 Worker matrix 与混合 Controller；其他候选的文档核对不算真实验收通过。

| Candidate | Current status | Current-round reason and evidence boundary |
|---|---|---|
| Command Code | `evidence-qualified` (Worker matrix + mixed Controller) | 四角色、目标模型、完整 native transcript、exact resume、Validator 同 Session/context 续接与只读 Recovery 通过。混合 Controller 中负责 Planner/Implementation，最终 deliverable、集成及同 Scope 重启通过；已注册。 |
| Qwen Code | `evidence-qualified` (Worker matrix + mixed Controller) | 四角色、目标模型、完整 native transcript、exact resume、Validator 同 Session/context 续接与只读 Recovery 通过。混合 Controller 中负责 Validator/Recovery/Finalizer，人工中断后替代 Session、最终 deliverable 及同 Scope 重启通过；已注册。 |
| CodeBuddy | `excluded-current-round` | Parent D01: no completed four-role/resume/Recovery production proof. `artifacts/next-worker-harness-adapters/codebuddy-excluded-startup-20261011.json` links seven real reports to session IDs, transcript paths and cwd across four fresh fixtures. Under ordinary `acceptEdits`, common shell actions were blocked by native approval. In the bypass diagnostic, the first three roles completed, but Finalizer's native write denial followed its attempted write contrary to the read-only instruction; the ask remained unsettled. Thus the full production chain did not pass. The same general boundary tradeoff also applies to other harnesses' relaxed native approvals (including Command/Qwen `--yolo`); it is not a CodeBuddy-only prohibition or the sole D01 rationale. Public temporary `cwd`/`trustedDirectories` and repo-hook cwd proof do not supply the missing full-chain evidence. |
| Grok CLI | `excluded-current-round` | Parent D01: complete session coverage and preservation of default config are unproven. Partial event numbering is not evidence of event loss; default mutation behavior remains unknown. |
| Antigravity CLI | `excluded-current-round` | User-login model interaction is evidenced, but no independent native header binds session ID/cwd to invocation; captured idle `--log-file` has no ID and Orca readiness failed. |
| Hermes Agent | `excluded-current-round` | Default `max_sessions=None` disables active registry writes; no alternative per-run report overlay is established. Do not change native cap/config to force registry writes. |
| Factory Droid | `waiting-verification` | **Not registered this round; future qualification remains possible.** Custom model/settings/hook path is documented, but the fresh `--settings` run reached Factory login before session work. Authentication prerequisite is unmet; no paid requirement or endpoint incompatibility is inferred. |
| Prime Agent | `excluded-current-round` | Exact resume/export and model configuration are available in source; checked Rust CLI has no process-scoped plugin-dir/report overlay and no verified current-child-to-new-session/cwd report. This is a current binding gap, not an endpoint rejection. |
| Cline CLI | `waiting-verification` | **Not registered this round; future qualification remains possible.** Private `--data-dir` plus native manifest PID/cwd/messages path is a concrete observer route; `--hooks-dir` and current hook identity fields are documented. Fresh Orca binding is untested, installed/source hook payload version match is unsettled, and custom provider requires native user config. |
| Goose | `excluded-current-round` | `SessionStart` reports ID/cwd but hook registration is native-global, with no per-run report overlay; actual no-prompt run exited `No provider configured`. |
| Crush | `excluded-current-round` | Reached native idle-ready state. Identity hook is `PreToolUse` only and there is no process-scoped report/config overlay, so no startup child-to-session binding is established. |
| Mistral Vibe | `excluded-current-round` | Hook can report session/transcript/cwd, but only through native hook setup; `VIBE_HOME` replaces the whole native root rather than additive overlay. Current startup requires Mistral sign-in/API key. |
| Autohand | `waiting-verification` | **Not registered this round; future qualification remains possible.** Exact resume/export, hook identity fields and one per-run `--plugin-dir` are documented. Tested `--offline --bare` mode requires `AUTOHAND_API_KEY` or `auth.apiKeyHelper`; this auth prerequisite is unmet, not evidence of unsupported BYOK. |
| GitHub Copilot CLI | `waiting-verification` | **Not registered this round; future qualification remains possible.** Official arbitrary OpenAI BYOK is environment-variable based; workspace trust is accepted, but user BYOK env is absent. No native persistent `envRef`/provider-file route was found. Exact session/cwd and repeatable process plugin flags exist; keep provider support true pending bounded readiness verification. |
| Cursor CLI | `excluded-current-round` | Checked official BYOK surface does not expose arbitrary base URL/third-party endpoints, which the target requires. This is the only direct endpoint-capability exclusion here. |
| Kimi Code | `excluded-current-round` | Custom OpenAI `base_url`, exact resume, ID export and native transcript are documented. Hooks carry session ID/cwd but are user-level; installed help has no additive per-run hook/plugin loader to bind that report to this child. |
| Kilo | `excluded-current-round` | Custom `options.baseURL`, exact resume and ID-addressed JSON export are documented. Installed CLI has no invocation-scoped plugin directory/report flag; native plugin discovery requires configuration. |
| MiniMax Code | `excluded-current-round` | 支持任意 base URL、三种 API 格式与精确 session 选择。但更新后的 Orca 上游没有 `mcode` builtin identity；已安装 CLI 也缺 export-by-ID、per-run plugin overlay 和可独立核验的新 Session ID/cwd 报告。 |

This table is the current disposition source. Later sections retain detailed evidence; earlier startup-gate observations are historical snapshots and do not override these statuses.

IP-04 fresh matrix 的[结构化证据](../../artifacts/next-worker-harness-adapters/ip04-2026-10-11T05-08-24-154Z-7fc1a011-b14e-47d2-8e5a-e550e0635a8d.json)与[摘要](../../artifacts/next-worker-harness-adapters/ip04-2026-10-11T05-08-24-154Z-7fc1a011-b14e-47d2-8e5a-e550e0635a8d.md)记录四角色 succeeded、目标模型、coverage complete、same-session resume、Validator context continuation 与 Recovery Utility。独立[混合 Controller 证据](../../artifacts/next-worker-harness-adapters/controller-20261011T085821980Z-89759c30-e5f4-4a09-8624-89e137fe85f5.json)记录 deliverable、5 bindings、1 Recovery、4 settlements 及同 Scope 重启保持原预算。两层验收分别通过；合成 adapter 测试不替代这些真实证据。

## 前台 session 保留与 seccomp 证据

父线程提供的本次实际 `ps` 记录如下；PID 是该次观测值，不是可复用身份。没有重新运行现场。

| 进程 | PID | PGID | SID | TTY | STAT | 已知事实 |
|---|---:|---:|---:|---|---|---|
| 外层 Node launcher | 2827109 | 2827109 | 2826420 | pts/51 | `Sl+` | 属于终端 foreground group |
| bwrap | 2827116 | 未提供 | 未提供 | 未提供 | `S+` | foreground 行 |
| 真实 Command agent | 2827117 | 2827117 | 2827117 | 未确证 | `Ssl` | `--new-session` 内另起 session/group，没有 `+` |

历史固定快照 `de15227a1d321840ea35c6bb2d0cc01e3409e5f1` 的 [`resolveAgentForegroundProcessFromPs`](https://github.com/stablyai/orca/blob/de15227a1d321840ea35c6bb2d0cc01e3409e5f1/src/main/providers/agent-foreground-process.ts#L168) 在 root 或后代含 `+` 时，仅选择含 `+` 的后代，再交给 agent recognition。上述真实 agent 因没有 `+` 被过滤；外层 Node/bwrap 不能证明当前真实 agent。该段记录的是旧源码对当时本机诊断的解释，不表示新固定快照或当前安装版本已复核同一 foreground gate。

另一个早期误识别来自 generated entry 的 `codex-` 文件名前缀。旧快照 [`agentForNormalizedProcess`](https://github.com/stablyai/orca/blob/de15227a1d321840ea35c6bb2d0cc01e3409e5f1/src/shared/agent-process-recognition.ts#L83) 将该前缀认作 Codex；旧快照 [`recognizeAgentProcessFromCommandLine`](https://github.com/stablyai/orca/blob/de15227a1d321840ea35c6bb2d0cc01e3409e5f1/src/shared/agent-process-recognition.ts#L279) 会先按 interpreter entrypoint 识别。父线程将 generated 文件名改为 `worker-model-launcher.mjs`，消除错误身份；这个修正不能解决真实 child 被 foreground gate 过滤的问题。该源码描述保留为旧快照历史证据。

后续 bounded 实测已验证替代过滤器可在保留当前前台 session/group 的同时拒绝 `TIOCSTI` 与 `TIOCLINUX`：父线程的 C syscall probe 对两者得到 `EPERM`，无关 ioctl 到达内核；SID/PGID 对照通过。实际只读 Command Code Orca adoption receipt 记录精确 native session、完整 transcript coverage、`exactWorker=true` 与 settled success。范围仅为本次 Linux/x86_64 Orca 路径，不外推其他 ABI 或所有候选；当前不能再把旧 `bwrap --new-session` 阻塞写成仍未解决的全局 production gate。来源及细节见 [`next-worker-harness-external.md`](next-worker-harness-external.md) 的 seccomp 与 adoption 记录。

## 已有本机候选

版本来源为本机安装包 manifest，或明确标注的公共版本输出/源码。模型目标为 **MiniMax-M3.1-Flash-Preview**；Antigravity 按 change 使用 **gemini-3.8-flash-medium**。Worker 认证继承原生环境，不从 Coordinator CredentialStore 取 key，不以 `.env.smoke` 为通用前置。

| 候选 | 已核验版本 / 命令 | 已有事实 | 本轮仍缺 |
|---|---|---|---|
| Command Code | `command-code` **1.79.2**；manifest 同时提供 `cmd`、`cmdc`、`commandcode` | IP-04 `zX9uxn` 中四角色均成功；目标模型、native session/transcript、coverage complete、exact resume、Validator same-session context continuation、Recovery Utility 均通过；已注册为 Worker harness | Worker matrix 与 mixed Controller 均 `evidence-qualified`；原生无 prompt 模型目录不可用，可手填 exact ID |
| Qwen Code | `@qwen-code/qwen-code` 基础安装 **0.21.6**，本机 managed npm active 包与 `qwen --version` 均为 **0.25.0**；可执行入口 `qwen` → `cli-entry.js` | IP-04 `zX9uxn` 中四角色均成功；目标模型、native session/transcript、coverage complete、exact resume、Validator same-session context continuation、Recovery Utility 均通过；已注册为 Worker harness | Worker matrix 与 mixed Controller 均 `evidence-qualified`。合成测试版本字符串不承担本机版本证明 |
| CodeBuddy | `@tencent-ai/codebuddy-code` **2.164.0**；`codebuddy`、`codebuddy-code`、`cbc` | 原生 SessionStart hooks/精确 transcript 路线；真实 cwd 可由 repo hook 的 `process.cwd()` 独立证明；公开临时 settings 有 `cwd` 与 `trustedDirectories`；旧 settled Task 的原生 assistant `providerData.model` 是目标 Flash | **本轮按父 D01 排除：完整生产资格未通过。** 七份报告 linkage 见 [`codebuddy-excluded-startup-20261011.json`](../../artifacts/next-worker-harness-adapters/codebuddy-excluded-startup-20261011.json)，覆盖 `GSKMM6`、`vHXxxQ`、`c9YsQ6`、`9juidq` 四个 fresh fixture。普通 `acceptEdits` 下常见 shell 操作受 native approval 阻塞；bypass 诊断仅前三角色完成，Finalizer 违反只读指令尝试写入后遭 native 拒绝，ask 未结算。因此没有完整四角色/resume/Recovery PASS。Relaxed native approval 的边界取舍也适用于 Command/Qwen `--yolo`，不是 CodeBuddy 专属禁令或单独排除理由。旧 settled Task 不等于当前资格。 |
| Grok | `@xai-official/grok` **1.0.50**；`grok`，安装包内 native binary | 父线程原生 TUI 首次 prompt 真正成功，首轮后显示目标 Flash；已有独立 summary identity；headless 原 Session identity 通过，实际 updates coverage 可读 partial | partial 与非连续事件号只代表 completeness 尚未证明，不能断言事件丢失；当前进程与 Session 完整绑定、resume fresh active registration、配置默认值变更触发条件均 unknown；不据此推测回滚 |
| Antigravity CLI | `agy --version` **1.3.3**（本次只读核验） | 用户登录后的模型交互成功；留存 `conversationId/workspacePaths/transcriptPath/modelName` 精确记录 `gemini-3.8-flash-medium` | 尚无 native independently proven ID/cwd 与 invocation report 的绑定；Orca readiness 留存为 `failed / agent_readiness`。当前 `--log-file` idle 日志无 ID；先前日志 trial 缺 native writable root，其写错误不证明生产拒绝 |
| Hermes Agent | 本机源码 `pyproject.toml` / `hermes_cli.__version__` **0.17.0**；`hermes` | 公共 exact resume/export；导出含 session metadata 与 messages | **本轮按父 D01 不纳入。** 默认 `max_sessions=None` 时 registry acquisition disabled，不写 `active_sessions.json`，因此默认启动无 registry PID/session 绑定；未发现可替代的 per-run report/hook overlay。不得修改 native cap 来强制写 registry。MiniMax 实际资格未测 |

### Command Code：真实 identity、模型与 resume

原始报告：`/var/tmp/ocp-next-harness-h4PUrG/command/3c494b3fe541c7443391/session-start.jsonl`。resume 报告：同 fixture 下 `resume/32b1225fcdca7cfc3d82/session-start.jsonl`。两者均指向 Session **`0dbc5468-4c49-4fb1-931c-7dac1d6aca5a`**，native transcript 为 `~/.commandcode/projects/var-tmp-ocp-next-harness-h4-p-ur-g-project/<ID>.jsonl`。

native v3 session header 的 `id/cwd` 独立于 report；assistant 记录形状为 `type: message`、`message.role: assistant`，**`model` 与 `usage` 在记录顶层**。已核对模型 `minimax-cn/MiniMax-M3.1-Flash-Preview`。读取 assistant 后才能接纳模型字段，user 记录、仅配置的 model_change 或任意 metadata 不构成该证明。分支 transcript 的 active leaf 与 parentId 链仍需保留，不把 JSONL 所有历史分支混成一条活动会话。

旧记录中的 `worker-start` 拒绝来自此前 launcher 路径，不再描述当前 wrapper 状态。后续 bounded 测试已有真实 Orca adoption receipt（见下方）；父线程报告新版四角色矩阵 PASS。同-session resume 与 Recovery Utility 仍在进行，因此不能把单次 adoption 或角色矩阵单独视为完整资格。

公开来源：[BYOK](https://commandcode.ai/docs/byok)、[mods](https://commandcode.ai/docs/mods)、[官方项目](https://github.com/CommandCodeAI/command-code)。本机实现参考 `src/adapters/agents/command-code-harness.ts`；它是候选实现证据，不是上游接口的独立证明。

### Qwen / CodeBuddy：已核对的 native Session

- Qwen：Session **`02ceafa9-1c5d-42d8-99e6-3ed25aa3f9b5`**；`~/.qwen/projects/-var-tmp-ocp-next-harness-h4PUrG-project/chats/<ID>.jsonl`。本次只读取身份与 assistant 模型字段，观察到目标 Flash。候选设计使用 `--chat-recording`、new `--session-id UUID`、resume `--resume UUID`，由 native `<ID>.runtime.json` 的 PID/ID/work_dir 与当前 child 对照，再独立复核 JSONL；该设计仍需真实 production 验收。公开来源：[官方源码](https://github.com/QwenLM/qwen-code)、[文档](https://qwenlm.github.io/qwen-code-docs/)。
- CodeBuddy：fixture 下 native 文件有 **`01a128e9-5111-7414-8408-3bcbafcf905b`** 与 **`01a128ee-6a6a-7164-a980-169ab1e0b8ea`**；后一文件 assistant 的 `providerData.model` 为目标 Flash。路径为 `~/.codebuddy/projects/var-tmp-ocp-next-harness-h4PUrG-project/<ID>.jsonl`，record 自带 `sessionId/cwd`。候选实现使用 invocation `--settings` SessionStart `startup|resume` hook 叠加与 exact `--resume ID`，不改默认项。公开来源：[安装包声明的官方首页](https://cnb.cool/codebuddy/codebuddy-code)、[官方 npm 包](https://www.npmjs.com/package/@tencent-ai/codebuddy-code)。本轮没有查到可单独引用的、版本固定的全部 hook/export 文档，不补造 URL 或完成结论。

### Grok：binding 路线、coverage 缺口与默认配置

本机文档位于 `~/.grok/README.md` 与 `~/.grok/docs/user-guide/`；公开入口：[官方 CLI](https://x.ai/cli)、[官方 npm 包](https://www.npmjs.com/package/@xai-official/grok)。安装包为 native binary，未取得可审阅的完整官方 Rust 源码；二进制内嵌源码路径/错误字符串只能证明相关代码路径存在。

已有公开 new `--session-id UUID`（new only）与 exact `--resume UUID`。native session 在实际 `GROK_HOME`（默认 `~/.grok`）下的 `sessions/<URL-encoded cwd>/<UUID>/`，包含 `summary.json`、`updates.jsonl`、`chat_history.jsonl`。`summary.info.id/cwd` 与模型字段须独立复核。使用 `encodeURIComponent(cwd)` 后只有 root、encoded cwd、ID、summary 与 header 精确一致才接纳；编码或路径无法一致时 unavailable，不按 cwd/mtime 寻找最近文件。

仅 poll 旧 summary 不足以证明 resume 属于当前进程。已认可的有界设计是 generated entry 持有本次 `spawn` 的 ChildProcess，核验 child 仍存活，并从 native `active_sessions.json` 找唯一匹配 `pid + session_id + cwd` 的 entry，`opened_at` 必须属于新 dispatch window；两个 matching entry 拒绝。随后复核 summary/header。它不要求另加私有 process_start 字段，也不把另一同 Session 进程的更新当当前进程。resume 是否确实产生 fresh active entry 由父线程实测，本记录尚无完成证据。TUI 没有已确证的逐次 plugin-dir 路线；ACP 的 plugin 加载能力不能直接代替 TUI 能力。

父线程新提供：headless 原 Session **`01a128eb-6166-7c13-ad1a-10da598bffcf`** 的 transcript identity 通过，但旧 `inspectTranscript` 返回 `Native event identity invalid or duplicated`。精确路径为 `~/.grok/sessions/encodeURIComponent('/var/tmp/ocp-next-harness-h4PUrG/project')/<ID>/updates.jsonl`。本次有界只读检查 14,141 bytes / 21 行 metadata，实际 eventId 后缀依次为 `2,3,5,10,6,11,12,13,2,4,3,8,7,11,9,10,18,14,19,20,21`：文件顺序不递增，后续段重置并复用 ID。原 UUID 加连续序号的合成测试遗漏真实语义；parser 已调整为原文件 `line:N` 唯一引用，不排序、不按重复 eventId 丢记录。序号不连续只触发保守的 partial-coverage heuristic，不能证明事件实际丢失；错误 Session/结构仍拒绝。此前 **14 个合成测试通过不等于 coverage 资格通过**。

修正后实际调用 identity/coverage reader（没有启动模型）得到同一 ID、`covered / partial`、范围 `line:1`–`line:21`、`lastCompleteEventRef=line:21`，14 处序号不连续。这里的 gaps 表达完整性尚未证明，不能断言每处都真的丢失事件。对应合成回归测试 16/16 通过，两个 Grok owned 文件 ESLint 通过；它们仅验证 parser/fixture 边界，不代表生产 adoption 或完整资格通过。

MiniMax direct M Plan 的追加配置路线为单独模型项：`api_backend = "chat_completions"`、`model = "MiniMax-M3.1-Flash-Preview"`、`base_url = "https://api.minimaxi.com/v1"`、`env_key = "MINIMAX_CN_API_KEY"`。父环境已有该 key；不读取或记录值。native alias `ocp-minimax-flash` 与实际模型 ID 不同，最终获批 selection 必须能与 native summary 校验一致；是否采用同名配置项由父线程处理。

**原默认值未知，`--model` 持久化触发条件未知。** 当前 `~/.grok/config.toml` 的 `[models].default` 为 `ocp-minimax-flash`，mtime `2026-10-11T03:08:22.434Z`；旧 `config.toml.bak-opencodex`（`2026-09-05T00:35:34.398Z`）没有 `models.default`。现有 fixture 没有 launch 前快照。启动首屏 Grok4.6 只证明首轮前画面，不能当原 default；首轮后父线程看到正确 Flash。官方本机配置参考第 452 行把 `models.default` 与 `GROK_DEFAULT_MODEL` / `--model` 对应；二进制有 `failed to save default model preference:` 字符串，但无法据此确定是 flag、初始化还是交互触发保存。没有可靠的 session-only 不落盘保证；不猜测 rollback，不修改默认，保留待决。

### Antigravity / Hermes 的独立证据边界

Antigravity 用户登录后的模型交互已通过，这是父线程报告的真实模型结果。`/var/tmp/ocp-next-harness-h4PUrG/agy-proof.jsonl` 报告 conversation **`e5ae2826-0db7-4032-8750-cc56d27c5307`**、workspace、transcript path 与 `modelName=gemini-3.8-flash-medium`，但本记录没有独立 native 证据把该 ID/cwd 与 invocation report 绑定，故不把此 report 单独当作精确 session 证明。installed 1.3.3 `--log-file` 只覆盖日志路径；当前 idle 日志没有 session ID。Orca readiness 留存为 `failed / agent_readiness`；该日志试验缺 native state 可写 root，其写错误不证明生产配置会拒绝。官方 [CLI reference](https://antigravity.google/docs/cli/reference/) 与 [hooks](https://antigravity.google/docs/hooks/) 的既有页面快照在 `/var/tmp/ocp-agy-{reference,hooks}.html`。

Hermes 0.17.0 的 `hermes_cli/active_sessions.py` 在启用 registry 时可登记 `session_id/surface/pid/started_at`，TUI launcher 另建立临时 `HERMES_TUI_ACTIVE_SESSION_FILE` 并在退出后删除；但默认 `max_sessions=None` 会让 `try_acquire_active_session` 返回 disabled，不写 `runtime/active_sessions.json`。已查 CLI 没有可替代的 per-run hook/report overlay，因此当前默认路径无法把新 Session 与 child/cwd 独立绑定。公共 `hermes sessions export --session-id ID -` 输出单 Session JSONL，包含 native session metadata 与 messages；`--resume ID` 选择精确会话，不直接读取 SQLite。对应本机源码为 `hermes_cli/main.py`、`hermes_state.py:export_session`、`hermes_cli/active_sessions.py`。公开 [源码](https://github.com/NousResearch/hermes-agent) 与 [provider 文档](https://hermes-agent.nousresearch.com/docs/integrations/providers)支持自定义 endpoint 路线；Flash 的追加配置、默认保持和真实响应尚未证明。**本轮按父 D01 不纳入**：默认 registry 不写且无 per-run overlay；不改 cap/config 规避此缺口。

## 已留存的真实 Orca 身份

以下来自 fixture `retained-evidence` 的既有记录，不是本轮新派发。前三项的 `worker.state=succeeded`、`stage=settled`，`observation.exactWorker=true`，provider model 字段为 null；模型证明必须另读 native transcript。新的 Command Code receipt 另证 bounded wrapper adoption；参见下方 Command Code 记录。旧 wrapper 阻塞不应覆盖这项后续通过事实。

| 候选 | Run | Task | Dispatch | 已记录结果 |
|---|---|---|---|---|
| Command | `run_037b0bc971fa` | `task_d0385f0592d4` | `ctx_07914b0360f9` | 历史 succeeded / settled；新 IP-04 Worker matrix 独立通过，见上述 receipt |
| Qwen | 同上 | `task_6988bbcf07d9` | `ctx_9f9ce1ef8b30` | 历史 succeeded / settled；新 IP-04 Worker matrix 独立通过，见上述 receipt |
| CodeBuddy | 同上 | `task_42b8261cc01b` | `ctx_fea56fd90ec4` | succeeded / settled，agentIdentity codebuddy |
| Antigravity | 同上 | `task_57d1152a6847` | `ctx_7e8446aeed9a` | lookup 记录 failed / agent_readiness |

后续 Command Code bounded adoption 的保留 receipt：`/var/tmp/ocp-next-harness-h4PUrG/retained-evidence/command-seccomp.json`，dispatch `ctx_101e8ded11d3`，Task `task_7ffdc0ad891d`，terminal `term_81e2abec-3146-438f-90bb-f76c0318e0f1`，native session `21436c7b-a724-4cc3-b0f5-e59264eb21b8`，`exactWorker=true`，transcript coverage complete，worker succeeded/settled。此后 IP-04 对 Command/Qwen 的 Worker matrix 完成 exact resume、Validator context continuation 与 Recovery Utility 验收并通过；详见上面的 fixture receipt。不要将 Worker matrix 的 PASS 扩大为 mixed Controller PASS。

Grok 的早期 `worker-start PASS` 由父线程消息报告，随后父线程确认 shared launcher 被误认 Codex；未有可在本记录复核的 Task/Dispatch ID。保留该历史观察，不把它计作正确 Grok production adoption。

## 其余候选：历史证据摘要

详细官方链接、安装过程和原始证据见同目录 [`next-worker-harness-external.md`](next-worker-harness-external.md)。下表保留既有来源与接口摘要；其中旧的“值得继续”及“当前资格事实”文字只是当时记录，**不得覆盖本页 `IP-01 / 03 current-round disposition (SSOT)` 的状态与理由**。早期 `main` 源码推断与固定版本 help 有差异时，以固定版本 help 为准。

| 候选 | 版本依据 | custom endpoint / 精确 transcript 与 resume / 单次 loader | 当时观察摘要（非当前 disposition） |
|---|---|---|---|
| Cline CLI | npm `3.0.70`；研究源码为 main，未固定该 release | custom OpenAI provider；`--tui --id ID` 与 session JSON artifact；`--hooks-dir`；history export 是 HTML，`--json` 仅 metadata | exact 3.0.70 flags、当前进程新 Session 绑定和 Flash 真实响应未知；[官方 CLI](https://github.com/cline/cline/blob/main/docs/cli/cli-reference.mdx) |
| Goose | 已安装 `1.54.0` | `base_url`；固定版本 `goose session --resume --session-id ID`，`session export --session-id ID --format json --output FILE`；逐次 hooks overlay 未确证 | 历史首启在 No telemetry 后退出 `No provider configured`；当前排除理由见上方 SSOT；[release](https://github.com/aaif-goose/goose/releases/tag/v1.54.0) |
| Crush | 已安装 `v0.98.1` | custom provider/base_url；`crush --session ID`，`session show ID --json`；per-run hook overlay 未确证 | 历史首启已到 idle-ready；当前 process-scoped report 缺口见上方 SSOT；[release](https://github.com/charmbracelet/crush/releases/tag/v0.98.1) |
| Mistral Vibe | 已安装 `2.26.1` | custom openai api_base；`--resume ID`，native meta.json/messages.jsonl；project/user plugins，逐次 overlay 未确证 | 历史首启已到 Mistral Studio sign-in/API-key gate；当前 overlay 缺口见上方 SSOT；[release](https://github.com/mistralai/mistral-vibe/releases/tag/v2.26.1) |
| Autohand | 已安装 `0.9.8 (1a3eaf7)` | custom OpenAI-compatible provider；`resume ID|name|path|unique-prefix`；固定安装 help 有 `--plugin-dir`，重复性未知 | 历史 `--offline --bare` invocation 触发 API-key/helper gate；当前 waiting 状态见上方 SSOT；[release](https://github.com/autohandai/code-cli/releases/tag/v0.9.8) |
| Copilot CLI | 已安装 `1.0.95` | 官方 BYOK OpenAI-compatible endpoint 通过 `COPILOT_PROVIDER_BASE_URL`、provider type/model/key 环境变量；`--resume=ID` / `--session-id ID`；native Session 文件及 share export；repeat `--plugin-dir` | 历史启动 trust gate 后已由 parent 确认 trust accepted；BYOK env 未配置，当前等待状态见上方 SSOT；[release](https://github.com/github/copilot-cli/releases/tag/v1.0.95)、[BYOK](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models) |
| Prime Agent | Rust commit **`2ee7e623a70d8ccd9c72ffc6c4f25be2cc1bc02d`**；非已安装版本声明 | Rust `--resume path|id`，`session export session-file [output]`；run parser 无 `--plugin-dir`；`update --extension` 是更新已安装包 | Official product research documents custom `models.json` provider/base URL; applicability to this exact Rust SHA is not established here. Current-round exclusion is the missing process-scoped report/child-to-session binding, not endpoint rejection; [fixed source](https://github.com/PrimeIntellect-ai/prime-agent/tree/2ee7e623a70d8ccd9c72ffc6c4f25be2cc1bc02d) |
| Droid | 版本未在本记录核验 | 官方 BYOK `customModels/baseUrl/provider`，apiKey 可环境变量引用；hook/CLI 文档已保存 | 不能由 BYOK 文档或 exec mode 推 TUI/process binding/Flash 通过；[BYOK](https://docs.factory.com/model-independence/byok)、[CLI](https://docs.factory.com/droid-cli/cli-reference)、[hooks](https://docs.factory.com/harness/hooks) |
| Cursor CLI | 版本未在本记录核验 | 已存 CLI auth/parameters 与编辑器 API-key 文档；编辑器 BYOK 不自动证明 CLI 任意 endpoint | CLI direct M Plan、精确导出/新 Session binding 未证；[CLI parameters](https://cursor.com/docs/cli/reference/parameters)、[API keys](https://cursor.com/help/models-and-usage/api-keys) |
| Kilo | 本机 `@kilocode/cli` manifest **7.8.8** | Custom `options.baseURL`; exact `-s/--session ID`; public `kilo export ID` JSON; native plugins/events load through configuration, no invocation-scoped plugin-dir flag | Current-round exclusion reason is missing process-scoped report overlay; arbitrary endpoint and exact resume/export are supported surfaces, MiniMax runtime not tested; [official CLI package](https://www.npmjs.com/package/@kilocode/cli/v/7.8.8), [fixed provider docs](https://github.com/Kilo-Org/kilocode/blob/76bcfd40be616a72f4697b3041565f322245b462/packages/kilo-docs/pages/ai-providers/openai-compatible.md) |
| Kimi Code | Installed `kimi` **2.1.1** | `openai` provider `base_url`; exact `--session ID`, session JSON list and ID-addressed ZIP export; native hooks have `session_id/cwd`, but no process-only hook overlay flag | Current-round exclusion reason is no additive process-scoped hook/plugin loader; endpoint schema and resume/export are supported surfaces, target runtime/version transcript details are not model-tested; [official docs](https://moonshotai.github.io/kimi-code/), [official repository](https://github.com/MoonshotAI/kimi-code) |
| MiniMax Code | Installed `mcode` **0.6.3** | `provider add --base-url`, three API formats and model IDs; exact session selection; official source describes native `manifest.json`/`messages.jsonl` | Current-round exclusion reason is no installed export-by-ID and no process-scoped report overlay to bind new ID/cwd to child; arbitrary endpoint schema is true, MiniMax request was not tested; [official npm package](https://www.npmjs.com/package/@minimax-ai/code/v/0.6.3), [official repository](https://github.com/MiniMax-AI/MiniMax-Code) |

Prime 研究文档包含两个相近但不同 SHA 的链接。上表以已保存官方 `prime/tree.json.sha` 的 **`...ffc6c4f...`** 为准，未将另一个 SHA 当同一快照。Prime Rust 与 `earendil-works/pi` TypeScript 是不同源码树/SessionManager；Rust v3 header 注释要求与 Pi 首行字段顺序一致，只证明序列化格式对应，不证明同 manager API 或 runtime 互通。详见固定 [Rust session types](https://github.com/PrimeIntellect-ai/prime-agent/blob/2ee7e623a70d8ccd9c72ffc6c4f25be2cc1bc02d/crates/pa-types/src/session.rs) 与 [Pi source](https://github.com/earendil-works/pi)。未修改原研究文件。

其余五项的 terminal 证据在 `/var/tmp/ocp-next-harness-h4PUrG/evidence/terminal-qualification/<candidate>-{create,show,read,wait}.json`。这些是现有父线程现场，本次只读取；没有接受首启选择、设置认证或调用模型。

## 下一决策与未完成验证

Command Code 与 Qwen Code 已通过 IP-04 Worker matrix 并正式注册：四角色、exact resume、Validator context continuation、Recovery Utility 均通过；父报告该次 fixture 为 45 passed / 2 skipped、730.57 秒、global hash unchanged。mixed Controller 已通过，最终 deliverable 并核验人工中断恢复和同 Scope 重启；参见上方 SSOT 与两层 IP-04 receipt。Hermes 按父 D01 当前不纳入：默认 cap 不写 active registry，且无 per-run report overlay。Goose、Crush、Vibe、Autohand、Copilot 当前状态见 SSOT disposition 表；Copilot 的官方 BYOK endpoint 支持为 true，trust 已通过，但用户 BYOK env 未配置，等待 bounded 验证。CodeBuddy 本轮按父 D01 排除的具体理由是完整四角色/resume/Recovery 生产链尚无 PASS：普通 `acceptEdits` 下常见 shell 操作受 native approval 阻塞；bypass 诊断仅前三角色完成，Finalizer 的原生写拒绝发生在其违反只读指令后，且 ask 未结算。Relaxed native approval 的边界取舍同样适用于 Command/Qwen `--yolo`，不构成 CodeBuddy 专属禁令或单独排除理由。各候选的精确 gap 见 [`next-worker-harness-external.md`](next-worker-harness-external.md)。Grok coverage 的 partial 是不连续 event numbering 所触发的保守 heuristic，并不证明事件丢失；其原生默认值和 `--model` 持久化触发条件仍 unknown，不做推断或回滚。没有逐项证据的候选不据此宣称 unsupported。

后续资格必须分别留下 native model/usage 与精确 Session、当前 generation binding、Worker Task/Dispatch/Delivery、Validator 同 Session 行为续接、Recovery Utility Capsule、混合 Controller 的授权 profiles/identity/budget/FinalVerdict。所有真实动作仍由已授权父线程进行，失败现场保留；现有原生通过项和阻塞项均不冒充未运行部分。
