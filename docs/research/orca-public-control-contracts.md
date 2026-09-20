# Orca 公开控制、身份与恢复契约核验

对应 ticket：[*核验 Orca 公开控制、身份与恢复契约*](https://github.com/leike0813/orca-companion/issues/2)（父地图 [*规划 Orca Companion M0–M2 的实现路径*](https://github.com/leike0813/orca-companion/issues/1)）。

结论先行：**本机 Orca CLI 1.4.198 的公开接口足以支撑一个受监督、可对账、可恢复的串行闭环**。Run/Task/Dispatch 命名空间、组合式 worker 启动回执、FIFO 邮件投递与确认、`worker_done` 归属校验、显式的 stop/unknown 状态机，以及只读的对账路径都已存在。**唯一可能在 M0 挡住的是协调者身份**：所有会产生副作用的编排命令都要求调用者拥有可证明的 stable pane identity，本机实测一个普通后台进程拿不到它，而 `--from <handle>` 可以把身份委托给一个已存在的活终端 handle。这条正好是 M0 唯一必须先探针验证的事实。

本文只记录只读得到的事实。**没有创建任何 Run、Task 或 Dispatch，没有派发或停止 worker，没有执行 `--inject`，没有修改 issue、submodule 或产品代码。**

## 1. 核验环境与事实等级

| 项 | 值 | 来源 |
| --- | --- | --- |
| Orca CLI | 1.4.198，`/home/joshua/.local/bin/orca` | `orca --version` |
| Orca runtime | `state: ready`、`reachable: true`、`runtimeId: f34e8953-f5ae-42b8-97db-90e33112562f` | `orca status --json` |
| 上游源码快照 | `de15227a1d321840ea35c6bb2d0cc01e3409e5f1` | `references/orca` submodule |
| 记录时间 | 2026-09-17 | — |

每项事实标注等级：

- **[实测]** 本机只读命令的真实输出。
- **[契约]** 只读上游源码、官方文档或 CLI 版本匹配 skill 的明确声明。
- **[探针]** 必须通过真实状态变更才能确认，本 ticket 未验证。

## 2. 能力矩阵

### 2.1 Run（命名空间与协调者收件箱）

| 能力 | 公开命令 | 机器可读输出要点 | 错误语义 | 等级 |
| --- | --- | --- | --- | --- |
| 创建并绑定 Run | `orca orchestration run-create --objective <text> [--from <handle>] [--retry-request <id>] --json` | `result.run{id,objective,consumer_generation}` | 无 sender 身份 → `no_active_sender_terminal`（exit 1）；无可证明 pane → `stable_pane_required` | 实测+契约 |
| 绑定已存在 Run | `orca orchestration run-use --id <run_id> [--from <handle>] [--takeover-legacy]` | `result.run{...}` | `run_not_found`；冒充他人身份 → `consumer_fenced` | 契约 |
| 查询当前绑定 | `orca orchestration run-current [--from <handle>] --json` | `result.run` 为对象或 `null` | 同上 | 实测 |
| 列举 Run | `orca orchestration run-list [--limit <n>] [--cursor <cursor>] --json` | `runs[]{id,objective,home_database,coordinator_handle,coordinator_pane_key,consumer_generation,legacy,created_at,updated_at}`，`nextCursor` | 无参可用，不要求身份 | 实测 |
| 查看单个 Run | `orca orchestration run-show --id <run_id> --json` | 同 run-list 单行；`home_database` 与 `coordinator_pane_key` 被 `exposeRun` 剔除后不外泄 | 不存在 → `run_not_found`（exit 1） | 实测 |

Run 是**命名空间与协调者收件箱**，本身不调度也不放置 worker（`run-create` spec notes，`references/orca/src/cli/specs/orchestration.ts`）。

### 2.2 Task 与 Dispatch

| 能力 | 公开命令 | 输出要点 | 错误语义 | 等级 |
| --- | --- | --- | --- | --- |
| 创建任务 | `orca orchestration task-create --spec <text> [--deps <json_array>] [--parent <task_id>]` | `task{id}` | — | 契约 |
| 列举与过滤 | `orca orchestration task-list [--status] [--ready] [--brief]` | 任务行；`--brief` 把 spec 截到 160 字符并标 `spec_truncated` | 无 sender 身份 → `no_active_sender_terminal` | 实测+契约 |
| 更新状态 | `orca orchestration task-update --id <task_id> --status <status> [--result <json>]` | 状态枚举 `pending / ready / dispatched / completed / failed / blocked` | — | 契约 |
| 派发到指定终端 | `orca orchestration dispatch --task <task_id> --to <handle> [--inject] [--dry-run]` | 回执 | `task_not_found` / `task_not_startable` / `inject_rejected` / `runtime_error`，均带 `data.nextSteps` | 契约 |
| 查看派发上下文 | `orca orchestration dispatch-show --task <task_id> [--preamble]` | `dispatch{status,failure_count,last_failure,capability_hash,launch_token_hash,process_incarnation,contract_version,depth}` | — | 实测 |

Dispatch 状态机（`references/orca/src/main/runtime/orchestration/types.ts`）：`pending / dispatched / completed / failed / circuit_broken`；worker 侧状态 `WorkerDispatchState`：`starting / ready / start_unknown / failed / succeeded / stopping / stop_unknown / stopped / abandoned`。**`start_unknown` 与 `stop_unknown` 是公开词汇，不是失败**，对应 AGENTS.md 第 5 节 `OperationOutcome` 的 `unknown`。

同一 Task 连续 3 次失败会触发 dispatch circuit breaker 并标记任务 failed（skill 指南 Tasks And Dispatch 小节）。

### 2.3 组合式 worker 启动（首选路径）

`orca orchestration worker-start --task <task_id> [--on <saved-environment>] [--worktree current|selector|new-child|new-top-level] (--agent <agent>|--terminal <handle>) [--model <id>] [--effort <level>] [--setup run|skip|inherit] [--retry-of <dispatch_id>] [--timeout-ms <n>]`

- **退出码语义是契约而非惯例**：只有 `ready` 退出 0；`failed` 或 `outcome_unknown` 退出 1，JSON 内含 `stage` 与 `failedStage`、`setup`、`effects`、`residualResources` 与恢复命令（`specs/orchestration-worker-specs.ts`）。**契约**
- 回执字段实测可见：`worker.state`、`stage`、`effects[]{kind,action,id}`、`residualResources[]`、`startOptions.launch.requested` 与 `startOptions.launch.effective`、`observation`、`terminalResource{ownershipState,releaseState,archive}`。**实测**（读自历史 dispatch，见 2.6）
- `--model` 与 `--effort` 只对 Claude、Codex、Cursor 生效，`--effort` 必须与 `--model` 同用，且都不能与 `--terminal` 组合。**契约**
- `--retry-of` 只链接新尝试，**不继承放置**，必须重述 `--on` 与 worktree 以及 `--agent` 或 `--terminal`。**契约**
- `--on` 只选 worker 服务器；Run 与命令留在当前服务器，后续用 Dispatch ID 路由，不重复 `--on`。远端 `current` 与 `new-child` 无效。**契约**

### 2.4 消息、投递与事件

| 能力 | 公开命令 | 要点 | 等级 |
| --- | --- | --- | --- |
| 发送消息 | `orca orchestration send --subject <text> [--to run:<id> / dispatch:<id> / @all] [--type <type>] [--task-id] [--dispatch-id] [--outcome] [--payload <json>]` | 类型：`status, dispatch, worker_done, merge_ready, escalation, handoff, decision_gate, question, heartbeat` | 契约 |
| 轮询收件箱 | `orca orchestration check [--terminal <h>] [--run <id>] [--ack <delivery_id>] [--unread / --peek / --all] [--types] [--wait] [--timeout-ms <n>]` | 默认返回绑定 Run **最旧的未确认 FIFO 批次（最多 50 条）**，`--ack` 前重复投递同批次 | 实测+契约 |
| 只读探查 | 同上加 `--peek` 或 `--all` | 不消费邮件 | 实测 |
| 阻塞等待 | 同上加 `--wait --types worker_done,escalation,question --timeout-ms <n>` | 等待条件；stdout 只输出一个 JSON 文档，`_keepalive` 行每 15 秒走 stderr | 契约 |
| 提问与答复 | `orca orchestration ask --question <text>` 或 `--resume <msg_id>`，答复用 `reply --id <msg_id> --body <text>` | 超时保持 pending，必须用原 message id 恢复 | 契约 |
| 决策门 | `orca orchestration gate-create --task <id> --question <text> --options <json_array>`、`gate-resolve`、`gate-list` | 门状态 `pending / resolved / timeout` | 契约 |
| 总览 | `orca orchestration inbox [--limit <n>] [--full]` | 跨收件人 | 契约 |

**关于事件：公开 CLI 里没有推送或订阅通道。** `orca agent-context --json` 的 234 个命令中没有 event 或 subscribe 或 watch 类命令，唯一的事件形态是 `check --wait` 的阻塞等待加 stderr keepalive。**实测+契约** 这意味着 Companion 的「事件驱动」只能实现为**有界轮询加批次确认**，而不是订阅流。

投递语义（`types.ts` 的 `DeliveryStatus`）：`outstanding / acknowledged / fenced`。**`fenced` 是生成代数偏移后的作废状态**：`consumer_generation` 每次重挂载都会自增以隔离前任消费者（`types.ts` 注释：Bumped on every re-attach; fences the prior consumer's dispatch Delivery）。**契约**

### 2.5 终端句柄与读取

| 能力 | 公开命令 | 输出要点 | 错误语义 | 等级 |
| --- | --- | --- | --- | --- |
| 列举终端 | `orca terminal list [--worktree <sel>] [--limit <n>] [--include-visual-layouts]` | `handle,ptyId,incarnationId,orphaned,worktreeId,branch,tabId,leafId,connected,writable,lastOutputAt,preview,executionHostId,agentIdentity`；结果级 `hostScope{hostIds,omittedHostIds}`、`topologyRevisions`、`totalCount`、`truncated` | — | 实测 |
| 查看终端 | `orca terminal show --terminal <handle>` | 同上单条加 `agentWait` | 失效 handle → `terminal_handle_stale`（exit 1） | 实测 |
| 有界读取 | `orca terminal read --terminal <handle> [--cursor <n>] [--limit <n>] [--screen]` | `terminal{handle,status,tail,truncated,limited,oldestCursor,nextCursor,latestCursor,returnedLineCount,source}`，`source` 取值 `stream / screen / screen-unavailable` | 失效 handle → `terminal_handle_stale` | 实测 |
| 输入 | `orca terminal send --terminal <handle> --text <t> [--enter] [--interrupt] [--wait-submit <s>]` | prompt 回执含 `requestId` 与阶段 `input_accepted` 到 `turn_started`；`--wait-submit` 上限 3600 秒 | `accepted` 只证明输入被接受，`turn_started` 才证明回合开始 | 实测+契约 |
| 等待条件 | `orca terminal wait --terminal <handle> --for exit` 或 `--for tui-idle --timeout-ms <ms>` | `wait.satisfied` 布尔 | 未满足 → 非零退出，便于链式调用判断 | 实测+契约 |
| 创建与分屏 | `orca terminal create`、`split`、`rename`、`switch`、`close` | — | — | 实测 |

**句柄是运行时作用域的。** 官方文档明确：Orca 重启或收到 stale handle 后必须用 `terminal list` 重新获取；上游实现里 `terminal.resolveIdentity` 优先、`terminal.show` 兜底，`terminal_handle_stale` 与 `terminal_gone` 触发 remint（`src/cli/handlers/orchestration/terminal-identity.ts`）。`terminal.send` 另有 `terminal_gone`。**实测+契约**

**存活判定必须是三值。** `classifyWorkerTerminalProcessIncarnation` 返回 `live / exited / unverifiable`；`hostScope` 缺项或 `executionHostId` 未覆盖时**不能**判为已退出（官方文档：A missing terminal is evidence that it exited only when its execution host is listed in hostScope）。`worker-terminal-host-scope.ts` 进一步规定：`absent` 是本地旧表示，`unreadable` **绝不可读作本地**。**实测+契约**

### 2.6 worker 观测、停止与对账

| 能力 | 公开命令 | 语义 | 等级 |
| --- | --- | --- | --- |
| 观测 | `orca orchestration worker-show --dispatch <id>` | 不存在 → `dispatch_not_found`（exit 1）；返回 `dispatch`、`worker`、`observation{status,exactWorker}`、`terminalResource` | 实测 |
| 读输出 | `orca orchestration worker-read --dispatch <id> [--source auto|transcript|terminal] [--cursor] [--limit]` | identity 漂移 → `worker_identity_changed`（exit 1）；`fallbackReason` 取值 `provider_unsupported / session_not_reported / transcript_empty / transcript_missing / transcript_unreadable / transcript_parse_failed / remote_capability_unavailable`；cursor 与 source 绑定，`source_changed` 时须重开读取 | 实测+契约 |
| 资源核算 | `orca orchestration worker-list [--run <id>] [--terminal-state <s>] [--include-remote] [--cursor] [--limit]` | 无需 sender 身份；`workers[]{dispatchId,taskId,runId,workerState,dispatchStatus,agentTerminalHandle,terminalState,resource}`；`terminalState` 取值 `active / reclaimable / retained / release_pending / release_unknown / released` | 实测 |
| 停止 | `orca orchestration worker-stop --dispatch <id>` | 只关闭该受监督 Dispatch 名下的精确 agent 终端；不删 worktree、setup 终端、配置页签或无关进程 | 契约 |
| 放弃并标记不确定 | `orca orchestration worker-abandon --dispatch <id>` | `processAction` 为 `none`，保留全部可能存活的资源，不做进程或文件系统动作 | 契约 |
| 释放 | `orca orchestration worker-release --dispatch <id>` | 幂等；先归档可读输出再关闭；重复调用报 `already_released`；**只有 `release_unknown` 退出 1** | 契约 |
| 保留 | `orca orchestration worker-retain --dispatch <id>` | 记录用户显式例外，后续 `worker-release` 清除 | 契约 |
| 请求对账 | `orca orchestration request-show --request <id>` | 只读；`state` 取值 `completed / pending / absent`，附 `interpretation` 文本 | 实测 |

`request-show` 的 `absent` 语义被源码明确写成不充分证据（`src/shared/orchestration-mutation-request.ts`：Absent is not proof that nothing happened）。本机对未知 request id 与非法格式 id 都返回 `ok:true` 加 `state: absent`，**exit 0**，因此调用方必须读 `state` 而不是退出码。

**不确定结果的对账协议**（`src/cli/orchestration-mutation-recovery.ts`）：当错误码属于 `runtime_unavailable / remote_runtime_unavailable / runtime_timeout / invalid_runtime_response` 且携带 `orchestrationRequestId` 时，CLI 会附加结构化 `recovery{queryCommand,retryCommand,recoveryBlocked,disposition: outcome_unknown}`，并**拒绝**给出「重启再试」式的盲目重试建议。`--retry-request` 必须是 Orca 打印的 UUID，复用它才能让运行时重放或合并而不产生第二个副作用；非法值直接 `invalid_argument`，绝不静默降级为新请求。**契约**

### 2.7 worktree、host 与 account

| 能力 | 公开命令 | 要点 | 等级 |
| --- | --- | --- | --- |
| 当前 worktree | `orca worktree current [--json]` | `id` 形如 `<repoId>::<abs path>`，含 `identity{key,executionHostId,instanceId}`、`hostId`、`head`、`branch`、`linkedIssue`、`workspaceStatus` | 实测 |
| 选择器 | `--worktree identity:` 或 `id:` 或 `name:` 或 `branch:` 或 `issue:` 或 `path:` 或 `active` | `orca worktree show --worktree name:main` 实际报 `selector_ambiguous`（exit 1）：**重名时 name 选择器不可靠**，脚本应使用完整 `id:` | 实测 |
| 创建 | `orca worktree create --name <n> [--agent <id>] [--prompt] [--setup run|skip|inherit] [--no-parent] [--base-branch]` | `--agent` 让 agent 占据首个终端 | 实测+契约 |
| host 列表 | `orca host list --json` | 本机只有 `kind 为 local`、`id 为 local`、`platform 为 linux` 的一条 | 实测 |
| 远端环境 | `orca environment list --json` | 本机为空数组 | 实测 |
| 账号 | `orca account list --json` | codex 已登记 2 个账号，claude 为 0 | 实测 |

## 3. 身份与 scope 约束

这是 M0 的核心风险面，主要依据 `src/main/runtime/rpc/methods/orchestration/runs/run-scope.ts` 与 `src/cli/handlers/orchestration/terminal-identity.ts`。

1. **绑定型命令必须有可证明的 stable pane identity。** `resolveOrchestrationCaller` 在初始化参数 `requireStablePane` 为真时，拿不到 pane key 就抛 `stable_pane_required`（Run this command inside a live Orca terminal）。`run-create`、`run-use`、`run-current` 都走这条路。**本机实测**：无 `ORCA_TERMINAL_HANDLE` 时 `run-current` 报 `no_active_sender_terminal`；伪造 handle 报 `stable_pane_required`；**传入一个真实活的终端 handle 则成功**（返回 `run: null`，exit 0）。
2. **声明的 handle 必须与运行时认证的身份一致。** `assertCallerHandleMatchesEvidence`：不一致抛 `consumer_fenced`，即「本终端被认证为 A，不能以 B 行事」。所以 `--from` 不是任意冒充，只在无认证证据的路径上等价于身份声明。
3. **Run 按 pane 绑定，一个 pane 只有一个当前 Run。** 通过 `getCurrentRunForPane` 解析；显式传入的 `--run` 与当前绑定不一致同样抛 `consumer_fenced`。换绑会取消消息等待者，因此**同一 pane 换 Run 会打断在途等待**。
4. **无身份的 structured session 会拒绝推测。** `ORCA_STRUCTURED_SESSION` 标记存在时，不能推断 sender 身份的命令直接报 `no_active_sender_terminal`，理由写得很直白：`check` 默认是破坏性的，猜错就会消费掉兄弟 pane 的未读批次。structured worker 没有 PTY，`terminal.resolveIdentity` 而非 `terminal.show` 才是它的正确探针。
5. **不确定 mutation 缺 `--from` 时 runtimeId 为 null。** `no_active_sender_terminal` 返回的 `_meta.runtimeId` 是 `null`，说明请求根本没到 runtime，这与「到了但失败」可区分，是做对账分类的有用信号。**实测**
6. **scope 由 controller 持有，不能信任模型填写的值。** Worker 的完成消息只带被注入的 `task-id` 与 `dispatch-id`，不自行提供 Run、server 或 terminal 身份（skill 指南与 `preamble.ts`）。`legacy_read_only` 与 `consumer_fenced` 分别覆盖「无权限」与「权限已过期」。
7. **嵌套深度是护栏不是安全边界。** 默认深度 1，worker 再派发报 `nested_worker_depth_exceeded`；源码明说一个能声明别的终端 handle 且自身启动证据不可验证的调用者可以把自己算成那个终端，Orca 不把 worker 当敌手。**Companion 不能依赖它做权限隔离。** **契约**

## 4. 恢复与会话续用的边界

1. **Run 级恢复成立。** `run-current --from <handle>` 可找回绑定；`worker-list` 无需身份即可枚举全部 worker 资源与 `terminalState`；`worker-show --dispatch` 给出 `effects`、`residualResources`、`startOptions`，足以在重启后重建「哪个 Dispatch 拥有哪个终端」。
2. **进程存活与身份是两件事。** `worker-show` 的 `observation.status` 与 `exactWorker` 分开报告；`worker-read` 在 identity 漂移时硬失败 `worker_identity_changed`，而不是返回可能属于别的进程的输出。**Orca 在这里比调用方更保守，Companion 应直接沿用这个判定。**
3. **终端句柄可重解析，provider session 不会自动续用。** handle remint 依赖 `ORCA_PANE_KEY` 到 `terminal.resolvePane` 的路径；但「复用终端」不等于「恢复同一个模型会话」。`selectExactWorkerProviderSession` 要求同时匹配 `paneKey`、`processIncarnation`、`connectionId`、`launchToken` 与 `observedAfter`，断言不了就返回 `null`。**LangGraph 的 `thread_id` 不是 provider session id。** **契约**
4. **可恢复 agent 是显式枚举。** `RESUMABLE_TUI_AGENTS` 含 claude、codex、gemini、antigravity、opencode、pi、mimo-code、droid、grok、devin、omp、prime-agent、copilot、kimi；**kilo 不在其中**。
5. **`dispatch --inject` 刻意保持非受监督。** 它不写 `worker_dispatches` 行，`worker-stop` 与 `worker-abandon` 永远不会关闭那个进程，报告为 `unsupervised`；settled 后 `worker-retain` 与 `worker-release` 报 `retained` 加 `no_owned_resource` 且不产生进程动作。**要生命周期权威就必须用 `worker-start`。** **契约**
6. **同类操作的幂等性已被运行时覆盖。** runtime 能力列表含 `worktree.create-idempotency.v1`、`terminal.create-idempotency.v2`、`orchestration.contract.v1`、`orchestration.worker-stop-verdict.v1`、`orchestration.federation-lifecycle-settlement.v1`。**Companion 应复用这些收据，而不是自建第二套权威。** **实测+契约**
7. **`reset` 是全局破坏性恢复口。** `orchestration reset` 的 `--all`、`--tasks`、`--messages` 清空本地编排库状态，不属于正常闭环，不应出现在 Companion 的常规路径。

## 5. M0 门禁结论

**现在就能证明的（只读已足够）：**

- 公开接口覆盖了一个受监督闭环所需的全部语义节点：Run 绑定、Task DAG、`worker-start` 组合启动（带 requested 与 effective 以及 residualResources 回执）、邮件 FIFO 投递与 `--ack`、`worker_done`（带 task 与 dispatch 归属）、观测与读取、stop 与 abandon 与 release、`request-show` 对账。
- 不确定结果**有一等公民词汇**：`start_unknown`、`stop_unknown`、`outcome_unknown`、`release_pending`、`release_unknown`、`absent`，并且源码明确禁止把 `absent` 或缺失 host scope 读作「没发生」。
- 错误语义可按 AGENTS.md 第 5 节分类：输入不合法（`invalid_argument`）、阶段不允许（`task_not_startable`、`stable_pane_required`）、scope 错误（`consumer_fenced`、`run_required`）、旧尝试（`stale_dispatch`、`worker_identity_changed`）、能力缺失（`inject_rejected`、`provider_unsupported`、`incompatible_runtime`、`method_not_found`）、后端不可达（`runtime_unavailable`、`remote_runtime_unavailable`、`runtime_timeout`）。
- 事件不能用订阅实现；必须落成 `check --wait` 的有界轮询加批次确认加去重键（Delivery id、request id、task 加 dispatch）。

**必须探针验证的（本 ticket 未做）：**

| 探针 | 要回答的问题 | 为什么它挡在 M1 与 M2 前面 |
| --- | --- | --- |
| P1 协调者身份 | `orca terminal create --worktree active --command ...` 返回的 handle，能否让 `run-create --from <handle>` 通过 `stable_pane_required` | 这是 M0 唯一的**硬门**。本机已证明真实活 handle 可以充当身份，但那个 handle 来自 Orca UI 创建的终端；**CLI 自建终端是否同样拥有 stable pane 未验证**。若否，headless Companion 无法成为协调者。 |
| P2 组合启动闭环 | 在隔离测试项目里跑 `run-create` 到 `task-create` 到 `worker-start --agent codex --worktree current`，真实回执与 `ready` 判定为何 | 回执形状与退出码目前只有源码与帮助文本支持；须实测 `state` 为 `ready`、`effects` 与 `observation.exactWorker`。 |
| P3 投递与确认 | `worker_done` 是否按 task 与 dispatch 正确归属；`check --ack` 后是否不再重放；批次上限是否确为 50 | 决定 Companion 的去重表与「先落盘后确认」顺序。 |
| P4 重启恢复 | Orca runtime 重启后，旧 handle 是否报 `terminal_handle_stale`、`worker-list` 是否仍给出同一 Dispatch、provider session 是否可续用 | 决定「重启不重复派发」与「validator 同会话修复」是否真能成立。 |
| P5 迟到事件 | 被 fence 的旧 worker 再发 `worker_done` 或执行 `check` 时是否确实 `consumer_fenced` | 验证「旧 worker 迟到完成不能覆盖新尝试」。 |
| P6 无 PTY worker | 本机默认新 agent 页签设置是否产生 structured worker；若是，`worker-read --source transcript` 与 `--source terminal` 的拒绝行为如何 | 影响 adapter 是否需要区分终端 worker 与 structured worker。 |

**会挡住 M1 与 M2 的公开接口缺口（候选，待 P1 判定）：**

> 如果 P1 证明**只有 Orca UI 内创建的终端**才拥有 stable pane identity，而 CLI `terminal create` 的 handle 不能承担 `--from`，那么一个独立前台 Companion 进程无法合法地成为协调者。这将是唯一的最小可复现缺口，需要在 M0 记录并停止推进 M1 与 M2，而不是绕道伪造身份或直写数据库。

## 6. 对 Companion 设计的直接约束

- **`OperationOutcome` 可以直接映射**：`accepted` 对应回执 `ready` 或 `accepted`；`unknown` 对应 `start_unknown`、`stop_unknown`、`outcome_unknown`、`release_unknown` 与恢复错误；`rejected` 对应带稳定 `error.code` 的拒绝。**不要把 worker 的「已完成」当任务通过**：`dispatchStatus` 为 `completed` 只表示派发结束，Orca 侧没有任何字段表达「项目验收通过」。
- **认领与去重必须由 Companion 自己维护**：Orca 提供 `request-show` 与 Delivery ack，但不提供「本项目只允许一个 controller 写者」的机制；`worker-list` 是全局的，不按 Companion 项目隔离。
- **不要用 `terminal send` 推进业务状态**：它只提供 `input_accepted` 与 `turn_started` 的输入回执，没有 task 或 dispatch 归属，skill 指南明确把「没有 task 状态需求」的场合划给它。
- **不要把 `orca orchestration reset`、直写 Orca 数据库或私有 RPC 当作恢复手段**；接口不足时记录缺口并阻塞，与 AGENTS.md 第 6 节一致。

## 7. 引用

**本机只读命令（2026-09-17，Orca 1.4.198）**：`orca --version`、`orca status --json`、`orca agent-context --json`、`orca skills list --json`、`orca skills get orchestration --full`、`orca skills get orca-cli --full`、`orca orchestration` 的 run-list 与 run-show 与 run-current 与 task-list 与 worker-list 与 worker-show 与 worker-read 与 dispatch-show 与 request-show（含不存在 id 的错误路径）、`orca terminal` 的 list 与 show 与 read 与 wait（含失效 handle）、`orca worktree` 的 current 与 show 与 list 与 ps、`orca host list --json`、`orca environment list --json`、`orca account list --json`、`orca agent hooks status --json`，以及若干 `--help`。

**上游源码（submodule `de15227`）**

- `src/cli/specs/orchestration.ts`、`src/cli/specs/orchestration-worker-specs.ts`
- `src/cli/handlers/orchestration/terminal-identity.ts`、`mutation-request.ts`、`mutation-request-show-handler.ts`、`message-check-handler.ts`、`run-handlers.ts`
- `src/cli/orchestration-mutation-recovery.ts`、`src/cli/retry-request-flag.ts`、`src/cli/runtime/client.ts`
- `src/shared/orchestration-mutation-request.ts`、`orchestration-retry-request-id.ts`、`orchestration-worker-output.ts`、`runtime-rpc-envelope.ts`、`worker-terminal-host-scope.ts`、`agent-session-resume.ts`、`orchestration-dispatch-refusal-contract.ts`、`structured-session-marker.ts`、`protocol-version.ts`
- `src/main/runtime/orchestration/types.ts`、`worker-provider-session.ts`、`worker-terminal-process-liveness.ts`、`worker-terminal-release-reconciliation.ts`、`preamble.ts`
- `src/main/runtime/rpc/methods/orchestration/runs/run-scope.ts`、`runs/runs.ts`、`runs/run-receipt.ts`、`runs/mutation-request-show.ts`、`messaging/dispatch-mailbox-fence.ts`、`worker/worker-control.ts`、`worker/worker-start-agent-placement.ts`、`orchestration-structured-worker-session.ts`、`orchestration-caller-workspace.ts`
- `docs/site/content/docs/cli/orchestration.mdx`、`docs/site/content/docs/cli/reference.mdx`

**官方文档**：[Orca CLI 参考](https://www.onorca.dev/docs/cli/reference)、[Orchestration](https://www.onorca.dev/docs/cli/orchestration)。
