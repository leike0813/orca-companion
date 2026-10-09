# Verification

## 验收对象与记录依据

- Change：`stabilize-agent-harness-core`；日期：2026-10-09。
- 规划基线：`c988b89242de226e1bab7be2fea05dd58c648033`；直接前驱 `rework-coordinator-provider-configuration` 已于2026-10-08归档。
- 验收对象：本次实施完成、经过最终全量测试的工作区，包括未提交修改与未跟踪的新文件。上述 commit 是基线，单独检出它不能代表被验证的实现；本轮没有创建实现 commit。
- 本文件按用户“直接根据你的上下文写 verification.md”的要求，补录本会话已经完成的实施、审计和验证结果。本次写作不重新运行测试，不将既有结果描述为新一轮验收。
- 原始结果与范围说明见 [实施证据](../../../artifacts/agent-harness-core/README.md)，文件及接缝映射见 [implementation-plan](implementation-plan.md)。

## 结论

**PASS：本 change 约定的核心循环、独立调试入口与对话交互范围。**

10/10任务完成；9个Requirement、13个Scenario有对应实现与测试或实测证据。该映射不表示每个Scenario都有独立的真实后端端到端测试：存储与内部错误在应用/工作流测试装配注入，HTTP/SSE、进程生命周期及恢复行为另经真实CLI链路验证。

最终全量Vitest结果为196个文件通过、7个跳过，2218项测试通过、16项跳过；8项真实CLI/PTY/固定SDK/HTTP-SSE用例全部通过。类型检查、lint、构建、严格OpenSpec验证和diff检查通过。限定审计发现的问题及收尾中复现的输入时序问题均已修复，最终全量检查包含这些修正。

此结论绑定上述已测试工作区，不声明已固定实现HEAD、已提交、已同步主规格或已归档。

## 完整性、正确性与设计一致性

| 维度 | 结果 |
| --- | --- |
| 完整性 | [tasks](tasks.md) 中10/10项完成，覆盖IP-01–06；9个Requirement、13个Scenario映射见下表 |
| 正确性 | 配置绑定、失败停止、有限重试、取消、恢复、只读边界与输入保护有行为回归；真实链路核验HTTP请求数与已提交历史 |
| 一致性 | 沿用TypeScript/LangGraph/Ink；D-01–07落实，共用轮次、历史/压缩和对话输入管线；调试不构造Scope或ControllerSnapshot |

下表实现路径以`src/`为共同前缀，测试路径保留`tests/`。

| Requirement / Scenario / IP-ID | 实现与核验证据 | 结果 |
| --- | --- | --- |
| Trusted configuration and durable turn termination；生产结构化响应、内部故障和重启；IP-01/02 | `workflow/coordinator/{nodes,turn-driver}.ts`、`adapters/storage/checkpoint-store.ts`、`bootstrap/foreground-planning-runtime.ts`；`tests/workflow/{coordinator-graph,agent-turn-driver}.test.ts`、checkpoint-store与foreground-planning-runtime测试。响应提交拒绝经真实图和共享驱动只请求一次，后续run保持durable halted | 通过 |
| Classified bounded model retries；重试上限、内部错误只失败一次；IP-01 | `workflow/coordinator/{model-call,nodes}.ts`；workflow回归与`tests/integration/debug-harness-e2e.test.ts`。断连/429每次模型调用最多3次尝试，400一次；普通内部、解析、提交、取消、fencing、上下文与输出超限不自动重试，SDK内层重试关闭 | 通过 |
| Halted turn overrides automatic wake；故障期间继续输入；IP-01/02 | 共享turn driver及`bootstrap/foreground-planning-runtime.ts`全入口闸门；foreground宿主、agent-turn-driver与真实E2E测试。新消息持久保留，pending/定时wake和维护不解除停止，重开等待明确retry | 通过 |
| User message admission；提交后崩溃、普通消息不回答交互；IP-02/04/05 | 生产消息准入、`application/coordinator/debug-user-message.ts`及独立输入身份；`tests/application/wake-admission.test.ts`、UI input store/protection测试、真实E2E。保持原Session/提交身份，普通消息与绑定interaction/revision的回答分离 | 通过 |
| Independent persistent debug conversations；普通目录重启；IP-04 | `bootstrap/{debug-entry,debug-runtime}.ts`、`adapters/storage/debug-session-store.ts`、`interfaces/cli/{argv,main}.ts`；debug-runtime、debug-session-store、CLI与真实E2E测试。非Git目录、独立XDG状态、明确新建/继续、不可变模型快照与正式SDK/凭据装配 | 通过 |
| Bounded read-only debug tools；工具续接与路径逃逸；IP-03 | `workflow/coordinator/debug-tools.ts`、`adapters/agents/debug-read-tools.ts`；`tests/adapters/debug-read-tools.test.ts`、工具loop及真实E2E。四种工具有路径/处理量/输出/时间界限，覆盖符号链接、Git子目录与literal pathspec、取消、微小输出预算和配对续接 | 通过 |
| Shared conversation and explicit loop controls；停止后明确恢复、退出时取消流；IP-05/06 | `interfaces/tui/components/conversation.tsx`、共用Composer/TranscriptReader、`interfaces/tui/{app,debug-app}.tsx`、`interfaces/tui/commands.ts`、`interfaces/tui/input/composer-key.ts`；debug-app、exit、PTY、turn driver与真实E2E。stop/retry来自命令SSOT，Ctrl+C先abort；三档画面见下 | 通过；完整六票人工视觉验收不在此结论内 |
| Debug input identity isolation；调试草稿与未知提交恢复；IP-05 | `application/ports/ui-input-store.ts`、`adapters/storage/ui-input-store.ts`、`interfaces/tui/input/input-protection.ts`、input-record-manager；对应store/protection/manager/debug-app测试。独立target、完整UiDraft/CAS、稳定submissionId与未知结果只核验；受理核验释放等待位，保留后来编辑 | 通过 |
| Real harness end-to-end verification；生产链路中的终止故障；IP-06 | `tests/integration/debug-harness-e2e.test.ts`、`tests/support/scripted-model-server.ts`及隔离MiniMax smoke。真实CLI→PTY→固定SDK→HTTP/SSE计数，工作流装配注入内部提交错误；MiniMax实测有总请求上限，记录见下 | 通过 |

## 实际运行结果

| 命令或检查 | 已执行结果与证据边界 |
| --- | --- |
| `pnpm test` | 最终修复后exit 0：196文件通过/7跳过，2218项通过/16跳过。日志：[final-vitest-2026-10-09-observed-input.log](../../../artifacts/agent-harness-core/final-vitest-2026-10-09-observed-input.log) |
| `pnpm exec vitest run tests/integration/debug-harness-e2e.test.ts` | 实施期间单独执行8/8通过；最终全量再次包含并通过全部8项 |
| `pnpm exec vitest run tests/tui/debug-app.test.tsx` | 最终输入状态修复后13/13通过；最终全量包含此回归 |
| `pnpm typecheck`、`pnpm lint`、`pnpm build` | exit 0；最后改动的TUI/PTY/E2E文件另通过限定eslint检查，最终测试修改后再次通过typecheck |
| `openspec validate stabilize-agent-harness-core --strict` | exit 0；完成任务记录更新后再次通过 |
| `git diff --check` | 实施与记录收尾后exit 0 |

真实E2E覆盖：问候与read_file配对/详情；400、429、断连的请求上限；停止后新输入及重开不发请求；明确retry沿原身份恢复；首个能力探针中Ctrl+C只发送一个探针请求；SSE中Ctrl+C取消；SIGTERM停止；SIGKILL保留durable running，重开要求明确恢复。测试服务逐项记录HTTP请求与活跃连接，每个服务有100请求硬上限；不以UI mock计数替代后端计数。

隔离MiniMax实测命令：

```sh
node artifacts/agent-harness-core/minimax-smoke.mjs /home/joshua/.local/state/orca-companion/ledger-lab/ledger-lab-main-20261009082337625-898346b7/repo/orca-companion.json
```

[result.json](../../../artifacts/agent-harness-core/minimax-2026-10-09T10-18-17.386Z/result.json)记录MiniMax-M3.1-Flash-Preview、新隔离Session `885312b3-ab21-4516-940d-9a57a4427186`：含能力探测共9/12个真实后端请求，3条已提交assistant记录、1个配对read_file，Ctrl+C退出码0，退出后活跃后端请求0。只读取原lab配置与CredentialStore，没有打开或推进原Session。此实测早于后续上下文、取消、工具边界和输入修正；这些修正由最终本地正式链路与回归验证，不声称再次执行了付费后端smoke。

最终[进程检查](../../../artifacts/agent-harness-core/process-check-2026-10-09T11-03-29.888Z.json)于2026-10-09 11:03:29 UTC执行：当前项目、原lab及本次E2E/MiniMax临时目录未发现残留Harness进程。退出后的连接数另由E2E与MiniMax记录证明。

## 限定审计与修复

审计范围覆盖模型请求与重试入口、wake/维护、失败提交、未决mutation与恢复、退出取消、调试独立身份/凭据装配、上下文和历史读写、只读工具路径、单写者锁及TUI输入保护。

已结清的审计问题：生产启动探针取消传播；debug上下文失败及压缩持久化遗漏；Git子目录diff越界；注册表读改写竞争；未知写者误接管；输入管理核验已受理后仍占等待位。追加回归覆盖并发retry迟到结果不能清除新的停止、退出期间迟到runtime不能复活、空会话建立可读checkpoint和微小输出预算。

收尾验证还发现并修复连续输入读取上一帧草稿的问题：连续独立文字/Enter事件及slash双Enter在旧时序下稳定失败，同步输入状态后通过。同一数据块中的回车仍遵守Ink粘贴语义，不被解释为自动提交。

PTY驱动的`waitIdle()`可在没有按键回显时提前返回；测试现等待可见草稿、回答编辑器与slash采用完成后再发送下一键。先前失败日志保留，未增加请求预算、放宽停止/取消断言或将失败用例跳过；最终全量通过。

本轮限定范围没有待修的已确认阻塞缺陷。未修改Worker授权、Orca调度语义或原lab现场；原有doctor改动保留并随相关回归验证。

## 原型对照与保留限制

[最终画面与计数](../../../artifacts/agent-harness-core/capture-2026-10-09T10-42-46.918Z/samples.json)包含120×40、80×24、50×40各自有色/无色版本，共54个PNG与文本帧，覆盖空会话、问候、折叠工具、详情、中文光标、slash、Palette、Help及协调工作区。fixture请求54个（Agent18），退出后活跃连接0。

已查看三档画面并对照#40/#47原型及源码，保持continuous transcript、用户边线、Agent标记、折叠工具、圆角composer和输入上方候选；协调sidebar宽度与窄屏隐藏规则保持。输入时序修正未改变上述布局；其行为由回归验证。

- 未执行完整Orca业务lab；active ledger-lab的剩余业务验收不因本change通过而完成。
- 未验证Windows、新的IME人工输入及六票原型的全部人工呈现验收；条件跳过的16项测试不计作通过。
- PID复用及不可读锁保守拒绝；注册表锁或回收锁自身崩溃遗留时仍需人工核验处理，不自动破锁。
- 本文件补录已经完成的验证，不包含新的独立代码复审，也不扩大为所有provider的实机兼容结论。
